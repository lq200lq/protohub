/**
 * 性能基线（迭代实施计划 M5-T9；对照 [平台设计方案.md](../../docs/平台设计方案.md) §2 的成功标准）。
 *
 * 三个读数都是**可复跑**的：`pnpm bench` 起一个只归本轮的服务端（*_test 库 + mktemp 存储），
 * 跑完连数据一起收。这里只测量与对照，不改标准——不达标就记偏差（§9），不动目标值。
 *
 * 三个读数：
 *   ① 项目列表 1000 条下 `GET /api/projects` 的耗时（§2 没给目标值，这是留档的基线）；
 *   ② ≤20MB 原型从"点发布"到链接可访问的耗时（§2：≤10s P95，3 个包实测）；
 *   ③ 原型访问 TTFB（§2：缓存命中 ≤100ms P95，验收方式是 `curl -w '%{time_starttransfer}'` × 50）。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { createPrismaClient } from '../packages/db/src/index.ts';
import { assertTestDatabase } from '../packages/db/src/seed/guard.ts';
import { hashPassword } from '../packages/db/src/seed/password.ts';
import { runSeed } from '../packages/db/src/seed/index.ts';
import { buildZip } from '../apps/server/src/testing/zip.fixture.ts';

const execFileAsync = promisify(execFile);

const baseUrl = (process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3399').replace(/\/+$/, '');
const databaseUrl = process.env.DATABASE_URL ?? '';
const username = process.env.BENCH_USERNAME ?? 'bench_admin';
const password = process.env.BENCH_PASSWORD ?? 'bench-password';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const DAY_MS = 86_400_000;

assertTestDatabase(databaseUrl);

/** §2 的目标值；不达标只记偏差，不改这里 */
const TARGETS = {
  listP95Ms: null as null | number, // §2 没给目标，只留基线
  publish20MbP95Ms: 10_000,
  ttfbP95Ms: 100,
};

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function line(label: string, values: number[], target: null | number): void {
  const p95Value = p95(values);
  const verdict =
    target === null
      ? '（§2 未给目标值，只留基线）'
      : p95Value <= target
        ? `达标（目标 ≤${String(target)}ms）`
        : `**未达标**（目标 ≤${String(target)}ms）`;
  console.log(
    `  ${label}：P95 ${p95Value.toFixed(1)}ms · min ${Math.min(...values).toFixed(1)}ms · max ${Math.max(...values).toFixed(1)}ms · n=${String(values.length)} ${verdict}`,
  );
}

const jar = new Map<string, string>();
let accessToken: null | string = null;

async function call(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<{ body: any; status: number; text: string }> {
  const headers: Record<string, string> = { ...init.headers };
  const cookies = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  if (cookies) headers.cookie = cookies;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${baseUrl}${path}`, {
    body: init.body,
    headers,
    method,
  });
  for (const line_ of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line_.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (pair && index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { body: parsed, status: response.status, text };
}

function data(result: { body: any }): any {
  return result.body && typeof result.body === 'object' ? result.body.data : null;
}

/** 造一个约 targetBytes 的 zip：随机字节压不动，所以 zip 体积≈目标体积（"≤20MB 的包"要真是 20MB） */
function fatZip(targetBytes: number, marker: string): Blob {
  const chunk = randomBytes(64 * 1024);
  const entries = [{ data: Buffer.from(`<html><body><h1>${marker}</h1></body></html>`, 'utf8'), name: 'index.html' }];
  let written = 0;
  let part = 0;
  while (written < targetBytes) {
    entries.push({ data: chunk, name: `assets/blob-${String(part).padStart(3, '0')}.bin` });
    written += chunk.length;
    part += 1;
  }
  return new Blob([buildZip(entries)], { type: 'application/zip' });
}

async function prepare(): Promise<void> {
  console.log('… 准备 *_test 库（seed + 压测账号 + 1000 个项目）');
  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.$transaction((tx) => runSeed(tx), { maxWait: 10_000, timeout: 30_000 });
    const role = await prisma.sysRole.findFirstOrThrow({
      where: { code: 'super_admin', deletedAt: null },
    });
    const passwordHash = await hashPassword(password);
    // 上一轮崩在这儿时账号可能已经在了：复用它（重置口令与角色），免得 unique 撞上
    const existing = await prisma.sysUser.findFirst({
      where: { deletedAt: null, username },
    });
    const user =
      existing === null
        ? await prisma.sysUser.create({
            data: {
              forcePasswordChange: false,
              passwordHash,
              realName: '压测账号',
              remark: 'bench.mts 建的测试账号',
              status: 1,
              username,
              userRoles: { create: { roleId: role.id } },
            },
          })
        : await prisma.sysUser.update({
            data: {
              forcePasswordChange: false,
              passwordHash,
              status: 1,
              userRoles: { deleteMany: {}, create: { roleId: role.id } },
            },
            where: { id: existing.id },
          });
    const projects = Array.from({ length: 1000 }, (_, index) => ({
      code: `bench-${RUN}-${String(index).padStart(4, '0')}`.slice(0, 63),
      createdBy: user.id,
      name: `压测项目 ${String(index)}`,
    }));
    // 分批写，免得一次 createMany 撞参数上限
    for (let offset = 0; offset < projects.length; offset += 200) {
      await prisma.protoProject.createMany({ data: projects.slice(offset, offset + 200) });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function cleanup(): Promise<void> {
  console.log('… 清理本轮压测建的行（bench-* 项目 + 压测账号）');
  const prisma = createPrismaClient(databaseUrl);
  try {
    const projects = await prisma.protoProject.findMany({
      select: { id: true },
      where: { code: { startsWith: 'bench-' } },
    });
    const projectIds = projects.map((row) => row.id);
    const prototypes = await prisma.protoPrototype.findMany({
      select: { id: true },
      where: { projectId: { in: projectIds } },
    });
    const prototypeIds = prototypes.map((row) => row.id);
    await prisma.protoAccessLog.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
    await prisma.protoReleaseEvent.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
    await prisma.protoRelease.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
    await prisma.protoUploadTask.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
    await prisma.protoPrototype.deleteMany({ where: { id: { in: prototypeIds } } });
    await prisma.protoProject.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.sysUser.deleteMany({ where: { username } });
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  await prepare();

  const login = await call('POST', '/api/auth/login', { body: JSON.stringify({ password, username }), headers: { 'content-type': 'application/json' } });
  accessToken = data(login)?.accessToken ?? null;
  if (accessToken === null) {
    throw new Error(`登录失败：${login.text.slice(0, 200)}`);
  }
  console.log('✔ 登录成功，开始测量\n');

  /* ① 项目列表（1000 条数据下） */
  const listTimes: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const startedAt = performance.now();
    const result = await call('GET', '/api/projects?page=1&pageSize=20');
    listTimes.push(performance.now() - startedAt);
    if (result.status !== 200) throw new Error(`项目列表请求失败：${String(result.status)}`);
  }
  line('① 项目列表（1000 条）GET /api/projects', listTimes, TARGETS.listP95Ms);

  /* ② 20MB 包：从受理到链接可访问 */
  const publishTimes: number[] = [];
  let accessPath = '';
  for (let round = 0; round < 3; round += 1) {
    const marker = `BENCH-${RUN}-${String(round)}`;
    const form = new FormData();
    form.append('file', fatZip(20 * 1024 * 1024, marker), `bench-${String(round)}.zip`);
    form.append('project', JSON.stringify({ code: `bench-p-${RUN}-${String(round)}`.slice(0, 63), name: `压测发布 ${String(round)}` }));
    form.append('prototype', JSON.stringify({ code: `bench-p-${RUN}-${String(round)}`.slice(0, 63), name: `压测原型 ${String(round)}` }));
    const startedAt = performance.now();
    const accepted = await call('POST', '/api/releases', { body: form });
    if (accepted.status !== 202) throw new Error(`发布受理失败：${accepted.text.slice(0, 200)}`);
    const taskId = data(accepted)?.taskId;
    let task: any = null;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      task = data(await call('GET', `/api/upload-tasks/${String(taskId)}`));
      if (task?.status === 'success' || task?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (task?.status !== 'success') throw new Error(`发布没跑成：${JSON.stringify(task?.error ?? task?.status)}`);
    accessPath = task.release.accessPath as string;
    const open = await call('GET', `${accessPath}/`);
    if (open.status !== 200 || !open.text.includes(marker)) {
      throw new Error(`链接打不开：${String(open.status)}`);
    }
    console.log(`  · 第 ${String(round + 1)} 个包：源包 ${String(task.sourceSize)} 字节 · 版本 v${String(task.release.versionNo)}`);
    publishTimes.push(performance.now() - startedAt);
  }
  line('② 20MB 包发布（受理→任务成功→链接可访问）', publishTimes, TARGETS.publish20MbP95Ms);

  /* ③ TTFB：按 §2 的验收方式走 curl 的 time_starttransfer */
  const ttfb: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const { stdout } = await execFileAsync('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{time_starttransfer}',
      `${baseUrl}${accessPath}/`,
    ]);
    ttfb.push(Number.parseFloat(stdout) * 1000);
  }
  line('③ 原型访问 TTFB（curl time_starttransfer）', ttfb, TARGETS.ttfbP95Ms);

  console.log(
    '\n注：③ 跑的是 `SERVE_STATIC=node`（开发期 Node 直出），§2 的 ≤100ms 是**nginx 直出 + 缓存命中**的口径；' +
      '两个形态的差值要记偏差而不是改标准（见 §9）。',
  );
  await cleanup();
}

await main();

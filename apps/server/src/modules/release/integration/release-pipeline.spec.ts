/**
 * 发布链路集成测试（计划 M3-T16，迭代实施计划 §3.6：真 DB `protohub_test` + 真磁盘）。
 *
 * 与单测的分工：单测把 repo/DB 换成桩，钉的是"每一段的判定"；这里钉的是**接线之后**才存在的行为——
 * 受理事务落库、`FOR UPDATE SKIP LOCKED` 取号、阶段回填、提交顺序（先落盘后写库）、失败清理、
 * 超时重投之后旧归属的写入真的改不动那一行（repo 不变量 2 只有库里才验得）、
 * §5.3 任务状态形状（含从未被断言过的失败态 `error` 对象）。
 * 不启动 Nest、不占端口：按代码自己的入口驱动（`ReleaseService.accept` / `UploadWorkerService.tick` 与
 * `sweep`，见 upload-worker.service.ts ~L211 "定时器与测试共用这个入口"）。
 *
 * 隔离：每次运行用 `RUN` 随机后缀造自己的用户/项目/原型，`afterAll` 只删自己创建的行；
 * 存储根是一次性 `/tmp` 目录，绝不碰 `~/protohub-storage`（开发者活数据）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@protohub/db';
import { ERROR_CODES, UPLOAD_WARNING_CODES } from '@protohub/shared';
import type { ReleaseAcceptedResult } from '@protohub/shared';

// 复用 seed.spec 的测试库护栏（packages/db/src/seed/guard.ts）：不是 *_test 库直接拒跑。
import {
  assertTestDatabase,
  databaseNameOf,
} from '../../../../../../packages/db/src/seed/guard';

import { BusinessException } from '../../../common/exception/business.exception';
import { UPLOAD_TASK_STALE_MS } from '../../../config/constants';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import { buildZip, type ZipEntryFixture } from '../../../testing/zip.fixture';
import type { AppEnvService } from '../../../config/app-env.service';
import { LocalStorageAdapter } from '../../storage/local-storage.adapter';
import { requireLocalPath } from '../../storage/storage.adapter';
import { manifestKey } from '../../storage/storage-keys';
import { ProjectRepo } from '../../project/project.repo';
import { PrototypeRepo } from '../../prototype/prototype.repo';
import { OperationAuditWriter } from '../../system/audit/operation-audit.writer';
import { PermissionCodeService } from '../../../common/permission/permission-code.service';
import type { Actor, RequestMeta } from '../../system/common/actor';
import { ReleaseCommitter } from '../pipeline/commit';
import { contentHashOf, type ReleaseManifest } from '../pipeline/postprocess';
import { stageStartProgress } from '../pipeline/progress';
import type { UploadPart } from '../pipeline/intake';
import { ReleaseRepo } from '../release.repo';
import { ReleaseService, type ReleaseRequest } from '../release.service';
import { UploadTaskService } from '../task/task.service';
import { VersionRepo } from '../version/version.repo';
import {
  UploadTaskRepo,
  type ClaimedTask,
  type FailurePatch,
  type SuccessPatch,
} from '../worker/upload-task.repo';
import { UploadWorkerService } from '../worker/upload-worker.service';

// 优先级与 seed.spec 完全一致：TEST_DATABASE_URL → 指向 _test 的 DATABASE_URL → 文档约定缺省值。
const targetUrl = (() => {
  const candidate =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL && databaseNameOf(process.env.DATABASE_URL).endsWith('_test')
      ? process.env.DATABASE_URL
      : undefined) ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub_test?schema=public';
  assertTestDatabase(candidate);
  return candidate;
})();

/** 本次运行的唯一标识：编码只允许小写字母/数字/短横线，hex 前缀 `it` 刚好合规。 */
const RUN = `it${randomBytes(4).toString('hex')}`;
const PROJECT_CODE = RUN;
const PROTO_CODE = `${RUN}-p01`;

const APP_JS = 'fetch("/api/data").then((r) => r.json());\nlocation.href = "/login";\n';
const GOOD_ENTRIES: ZipEntryFixture[] = [
  {
    name: 'index.html',
    data:
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/site.css"></head>' +
      `<body><script src="/assets/app.js"></script></body></html>`,
  },
  { name: 'assets/site.css', data: 'body{background:url("/assets/bg.png")}' },
  { name: 'assets/app.js', data: APP_JS },
  { name: 'assets/bg.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  // §2.4 的垃圾项：受理与解压都跳过，但要出现在 manifest.skipped 里。
  { name: '.DS_Store', data: 'junk' },
];
const MINIMAL_ENTRIES: ZipEntryFixture[] = [
  { name: 'index.html', data: '<html><body>ok</body></html>' },
  { name: 'about.html', data: '<html><body>about</body></html>' },
];
/** 中央目录谎报解压尺寸的条目：受理轻校验只看声明值会放行，真解压时由 yauzl 拦下（extract.ts 不信任②）。 */
const LYING_ENTRY_ENTRIES: ZipEntryFixture[] = [
  ...MINIMAL_ENTRIES,
  { name: 'assets/lie.js', data: 'small', uncompressedSize: 65_536 },
];
/** 没有任何 index.html 候选：按实现这是在受理（validating）就 4xx，而不是等 postprocess。 */
const NO_ENTRY_ENTRIES: ZipEntryFixture[] = [
  { name: 'about.html', data: '<html><body>no entry</body></html>' },
];

const REQUEST_META: RequestMeta = { method: 'POST', path: '/api/releases', ip: '127.0.0.1' };

let prisma: PrismaClient;
let clientA: PrismaClient;
let clientB: PrismaClient;
let storageRoot: string;
let env: AppEnvService;
let storage: LocalStorageAdapter;
let userId: bigint;
let actor: Actor;
let releaseService: ReleaseService;
let taskRepo: UploadTaskRepo;
let taskService: UploadTaskService;
let worker: UploadWorkerService;
let workerA: UploadWorkerService;
let workerB: UploadWorkerService;
/** beforeAll 是否已经建过行（建了才需要在 afterAll 里删干净）。 */
let rowsCreated = false;

function releaseRequest(fields: Record<string, string>, zip: Buffer): ReleaseRequest {
  const uploadParts: UploadPart[] = [];
  for (const [fieldname, value] of Object.entries(fields)) {
    uploadParts.push({ fieldname, type: 'field', value });
  }
  uploadParts.push({ fieldname: 'file', file: Readable.from(zip), filename: 'demo.zip', type: 'file' });
  return {
    headers: {},
    isMultipart(): boolean {
      return true;
    },
    async *parts(): AsyncGenerator<UploadPart> {
      for (const part of uploadParts) {
        yield part;
      }
    },
  };
}

async function intake(fields: Record<string, string>, entries: ZipEntryFixture[]): Promise<{
  accepted: ReleaseAcceptedResult;
  zip: Buffer;
}> {
  const zip = buildZip(entries);
  const accepted = await releaseService.accept(releaseRequest(fields, zip), actor, REQUEST_META);
  return { accepted, zip };
}

/** §5.1 场景二：已有项目下新建原型（受理会 INSERT prototype(status='draft') + task）。 */
function intakeCreatePrototype(projectId: bigint, code: string, entries: ZipEntryFixture[]) {
  return intake(
    {
      projectId: String(projectId),
      prototype: JSON.stringify({ code, name: `集成原型 ${code}` }),
    },
    entries,
  );
}

/** §5.1 场景三：已有原型追加版本——"失败重试复用 draft"走的正是这条路。 */
function intakeAppend(prototypeId: bigint, entries: ZipEntryFixture[], note?: string) {
  const fields: Record<string, string> = { prototypeId: String(prototypeId) };
  if (note !== undefined) {
    fields.note = note;
  }
  return intake(fields, entries);
}

async function newProject(suffix: string): Promise<bigint> {
  const row = await prisma.protoProject.create({
    data: { code: `${RUN}-${suffix}`, createdBy: userId, name: `集成测试项目 ${suffix}` },
  });
  return row.id;
}

async function newPrototype(projectId: bigint, suffix: string): Promise<bigint> {
  const row = await prisma.protoPrototype.create({
    data: {
      code: `${RUN}-${suffix}`,
      createdBy: userId,
      name: `集成测试原型 ${suffix}`,
      projectId,
    },
  });
  return row.id;
}

async function listTmp(): Promise<string[]> {
  return readdir(join(storageRoot, 'tmp'));
}

/** 受理失败也要拿到那条 BusinessException：非 BusinessException 一律原样上抛（不吞真 bug）。 */
async function acceptFailure(run: Promise<unknown>): Promise<BusinessException> {
  return run.then(
    () => {
      throw new Error('受理本应失败，却没有失败');
    },
    (error: unknown) => {
      if (error instanceof BusinessException) {
        return error;
      }
      throw error;
    },
  );
}

function taskRow(taskId: bigint | string) {
  return prisma.protoUploadTask.findFirstOrThrow({ where: { id: BigInt(taskId) } });
}

function releaseRows(prototypeId: bigint) {
  return prisma.protoRelease.findMany({ orderBy: { versionNo: 'asc' }, where: { prototypeId } });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), `protohub-it-${RUN}-`));
  prisma = createPrismaClient(targetUrl);
  // 两个 Worker 实例各持一条独立连接：共享同一测试库，`FOR UPDATE SKIP LOCKED` 才是真并发。
  clientA = createPrismaClient(targetUrl);
  clientB = createPrismaClient(targetUrl);

  env = fakeAppEnv({ STORAGE_ROOT: storageRoot });
  storage = new LocalStorageAdapter(env);
  await storage.onModuleInit();

  const user = await prisma.sysUser.create({
    data: {
      passwordHash: 'integration-test-no-login',
      realName: `集成测试用户 ${RUN}`,
      username: `it-user-${RUN}`,
    },
  });
  userId = user.id;
  rowsCreated = true;
  actor = {
    dataScope: 'all',
    isSuperAdmin: true,
    roles: ['super_admin'],
    userId: user.id.toString(),
    username: user.username,
  };

  const projects = new ProjectRepo(prisma);
  const prototypes = new PrototypeRepo(prisma);
  releaseService = new ReleaseService(
    new ReleaseRepo(prisma, projects, prototypes),
    projects,
    prototypes,
    new OperationAuditWriter(prisma),
    env,
    new PermissionCodeService(prisma),
    storage,
  );
  taskRepo = new UploadTaskRepo(prisma);
  taskService = new UploadTaskService(
    taskRepo,
    new VersionRepo(prisma),
    prototypes,
    env,
  );
  worker = new UploadWorkerService(
    taskRepo,
    new ReleaseCommitter(prisma, storage),
    env,
    storage,
  );
  const makeWorker = (client: PrismaClient): UploadWorkerService =>
    new UploadWorkerService(
      new UploadTaskRepo(client),
      new ReleaseCommitter(client, storage),
      env,
      storage,
    );
  workerA = makeWorker(clientA);
  workerB = makeWorker(clientB);
}, 30_000);

afterAll(async () => {
  try {
    if (rowsCreated) {
      // 只删本次运行创建的行（created_by/user_id 全部等于 RUN 用户）；绝不 truncate、绝不碰别人的行。
      await prisma.protoUploadTask.deleteMany({ where: { createdBy: userId } });
      await prisma.protoReleaseEvent.deleteMany({ where: { operatorId: userId } });
      await prisma.protoRelease.deleteMany({ where: { createdBy: userId } });
      await prisma.protoPrototype.deleteMany({ where: { createdBy: userId } });
      await prisma.protoProjectMember.deleteMany({ where: { userId } });
      await prisma.protoProject.deleteMany({ where: { createdBy: userId } });
      await prisma.sysOperLog.deleteMany({ where: { userId } });
      await prisma.sysUser.delete({ where: { id: userId } });
    }
  } finally {
    // 清理失败必须可见（漏行就是污染共享测试库），但连接与一次性存储根仍要收尾。
    await Promise.all([prisma?.$disconnect(), clientA?.$disconnect(), clientB?.$disconnect()]);
    await rm(storageRoot, { force: true, recursive: true });
  }
}, 30_000);

describe('发布链路全链路（受理→Worker 四阶段→提交，§5.3 成功态）', () => {
  it(
    '真包发布：库记录、磁盘产物、manifest、指针、事件与任务状态逐项一致',
    async () => {
      const { accepted, zip } = await intake(
        {
          note: '集成测试首版',
          project: JSON.stringify({ code: PROJECT_CODE, name: `集成项目 ${RUN}` }),
          prototype: JSON.stringify({ code: PROTO_CODE, name: `集成原型 ${RUN}` }),
        },
        GOOD_ENTRIES,
      );
      const projectId = BigInt(accepted.projectId);
      const prototypeId = BigInt(accepted.prototypeId);
      const taskId = BigInt(accepted.taskId);
      const accessPath = `/p/${PROJECT_CODE}/${PROTO_CODE}`;

      // —— 受理（§3.0/§5.1）：一个事务里 project + prototype(draft) + task(pending)，文件已换正式名 ——
      expect(accepted.accessPath).toBe(accessPath);
      const prototype = await prisma.protoPrototype.findFirstOrThrow({ where: { id: prototypeId } });
      expect(prototype.status).toBe('draft');
      expect(prototype.currentReleaseId).toBeNull();
      const member = await prisma.protoProjectMember.findFirst({
        where: { projectId, userId },
      });
      // 创建者必须被加成 owner（数据范围按成员表判定，机制 §3.0 a）。
      expect(member?.memberRole).toBe('owner');
      const pendingLeftovers = (await listTmp()).filter((name) => name.startsWith('upload-pending-'));
      expect(pendingLeftovers).toEqual([]);
      const acceptedTask = await taskRow(taskId);
      expect(acceptedTask.status).toBe('pending');
      expect(acceptedTask.stage).toBeNull();
      expect(acceptedTask.progress).toBe(0);
      expect(acceptedTask.note).toBe('集成测试首版');
      expect(acceptedTask.tempKey).toMatch(new RegExp(`^tmp/upload-${String(taskId)}-[0-9a-z]{8}\\.zip$`));
      const zipAbs = requireLocalPath(storage, String(acceptedTask.tempKey));
      expect(await readFile(zipAbs)).toEqual(zip);

      // —— Worker：claim → extracting → postprocess → committing（§2.1）——
      expect(await worker.tick()).toBe(true);

      const statusRow = await taskRepo.findForStatus(taskId);
      expect(statusRow?.status).toBe('success');
      expect(statusRow?.progress).toBe(100);
      expect(statusRow?.stage).toBe('committing');
      const releaseId = statusRow?.releaseId;
      expect(releaseId).not.toBeNull();
      if (releaseId === null || releaseId === undefined) {
        throw new Error('成功任务必须带 releaseId');
      }

      // —— §3.1 的库侧：版本行 + 指针 + publish 事件 ——
      const release = await prisma.protoRelease.findFirstOrThrow({ where: { id: releaseId } });
      expect(release.versionNo).toBe(1);
      expect(release.status).toBe('ready');
      expect(release.note).toBe('集成测试首版');
      expect(release.storageKey).toBe(`releases/${String(projectId)}/${String(prototypeId)}/${String(releaseId)}`);
      expect(release.entryFile).toBe('index.html');
      expect(release.sourceHash).toBe(sha256Hex(zip));
      const manifest = release.manifest as unknown as ReleaseManifest;
      expect(manifest.entry).toBe('index.html');
      expect(manifest.fileCount).toBe(4);
      expect(manifest.rewrites).toEqual({ css: 1, html: 2 });
      expect(manifest.skipped).toEqual([{ p: '.DS_Store', reason: 'junk' }]);
      expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, f) => sum + f.size, 0));
      expect(release.contentHash).toBe(contentHashOf(manifest.files));

      const published = await prisma.protoPrototype.findFirstOrThrow({ where: { id: prototypeId } });
      expect(published.status).toBe('published');
      expect(published.currentReleaseId).toBe(releaseId);
      expect(published.firstPublishedAt).not.toBeNull();
      expect(published.publishedAt).not.toBeNull();

      const events = await prisma.protoReleaseEvent.findMany({ where: { prototypeId } });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe('publish');
      expect(events[0]?.toReleaseId).toBe(releaseId);
      expect(events[0]?.fromReleaseId).toBeNull();

      // —— §3.1 的盘侧：先落盘后写库，releases 三级目录就是站点根 ——
      const releaseDir = requireLocalPath(storage, release.storageKey);
      const html = await readFile(join(releaseDir, 'index.html'), 'utf8');
      expect(html).toContain(`${accessPath}/assets/app.js`);
      expect(html).not.toContain('"/assets/');
      const css = await readFile(join(releaseDir, 'assets/site.css'), 'utf8');
      expect(css).toContain(`${accessPath}/assets/bg.png`);
      // §2.6 硬约束 1：JS 一个字都不改——里面两条根绝对路径必须原样在场。
      expect(await readFile(join(releaseDir, 'assets/app.js'), 'utf8')).toBe(APP_JS);
      expect(existsSync(join(releaseDir, 'assets/bg.png'))).toBe(true);
      expect(existsSync(join(releaseDir, '.DS_Store'))).toBe(false);
      // 清单副本在版本目录之外（§1.2/§2.7），内容与 jsonb 权威逐字节一致。
      const manifestAbs = requireLocalPath(
        storage,
        manifestKey(String(prototypeId), String(releaseId)),
      );
      expect(JSON.parse(await readFile(manifestAbs, 'utf8'))).toEqual(release.manifest);
      // 工作目录被 rename 走了；成功路径不删原始包（留给重投/GC，见 upload-worker.service.ts 注释③）。
      expect(existsSync(join(storageRoot, 'tmp', `work-${String(taskId)}`))).toBe(false);
      expect(existsSync(zipAbs)).toBe(true);

      // —— §5.3 前端读的响应形状 ——
      const view = await taskService.status(actor, accepted.taskId);
      expect(view.taskId).toBe(accepted.taskId);
      expect(view.projectId).toBe(accepted.projectId);
      expect(view.prototypeId).toBe(accepted.prototypeId);
      expect(view.status).toBe('success');
      expect(view.progress).toBe(100);
      expect(view.stage).toBe('committing');
      expect(view.sourceName).toBe('demo.zip');
      expect(view.sourceSize).toBe(zip.length);
      expect(view.error).toBeNull();
      expect(view.warnings.some((w) => w.code === UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH
        && w.count === 3
        && w.message.includes(accessPath))).toBe(true);
      const summary = view.release;
      expect(summary).not.toBeNull();
      if (summary === null) {
        throw new Error('success 状态必须给出 release 摘要');
      }
      expect(summary.id).toBe(String(releaseId));
      expect(summary.versionNo).toBe(1);
      expect(summary.entryFile).toBe('index.html');
      expect(summary.fileCount).toBe(4);
      expect(summary.contentHash).toBe(release.contentHash);
      expect(summary.accessPath).toBe(accessPath);
      expect(summary.accessUrl).toBe(`${env.env.http.publicBaseUrl}${accessPath}`);
      expect(Number.isFinite(Date.parse(summary.publishedAt))).toBe(true);

      const audits = await prisma.sysOperLog.findMany({
        where: { resourceType: 'prototype', userId },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );

  it(
    '失败任务的 §5.3 error 对象：稳定 errorCode + 人话 message（extracting 拦下谎报尺寸的包）',
    async () => {
      const projectId = await newProject('fail');
      const { accepted } = await intakeCreatePrototype(projectId, `${RUN}-fail-p01`, LYING_ENTRY_ENTRIES);
      const taskId = BigInt(accepted.taskId);

      expect(await worker.tick()).toBe(true);
      const view = await taskService.status(actor, accepted.taskId);
      expect(view.status).toBe('failed');
      expect(view.stage).toBe('extracting');
      expect(view.release).toBeNull();
      expect(view.progress).toBeGreaterThanOrEqual(10);
      expect(view.progress).toBeLessThan(100);
      expect(view.error).not.toBeNull();
      // §8 的人话文案（阈值现算，但这句与数字无关）+ Worker 保留的原始 message。
      const failure = view.error;
      if (failure === null) {
        throw new Error('failed 状态的 §5.3 响应必须带 error 对象');
      }
      expect(failure.errorCode).toBe(ERROR_CODES.UPLOAD_NOT_ZIP);
      expect(failure.message).toContain('文件不是有效的 zip 格式');
      expect(failure.message.length).toBeGreaterThan(failure.errorCode.length);
      expect(view.warnings).toEqual([]);

      // 失败清理：这一次尝试的工作目录当场回收；原始包留着给重试（§3.2 重投还要读它）。
      expect(existsSync(join(storageRoot, 'tmp', `work-${String(taskId)}`))).toBe(false);
      const task = await taskRow(taskId);
      expect(task.tempKey).not.toBeNull();
      expect(existsSync(requireLocalPath(storage, String(task.tempKey)))).toBe(true);
    },
    30_000,
  );

  it('受理轻校验不过（无 index.html）：直接 4xx，不落任何库记录、不留半截 tmp 文件', async () => {
    const projectId = await newProject('noentry');
    const prototypeCode = `${RUN}-noentry`;
    // 计数按"本运行用户创建的行"取增量：同文件的用例会先后建 task，绝对值 0 会被前面的用例污染。
    const before = {
      projects: await prisma.protoProject.count({ where: { createdBy: userId } }),
      prototypes: await prisma.protoPrototype.count({ where: { createdBy: userId } }),
      tasks: await prisma.protoUploadTask.count({ where: { createdBy: userId } }),
    };

    const err = await acceptFailure(
      intake(
        {
          projectId: String(projectId),
          prototype: JSON.stringify({ code: prototypeCode, name: '无入口原型' }),
        },
        NO_ENTRY_ENTRIES,
      ).then((r) => r.accepted),
    );
    // M3-T2 判据"轻校验不过时不落任何库记录"——但 §2.1 的 postprocess 行还把 UPLOAD_MISSING_ENTRY
    // 写成"任务 failed"，实现实际在受理就拒绝（validate.ts:301）。这里断言实现的行为。
    expect(err.errorCode).toBe(ERROR_CODES.UPLOAD_MISSING_ENTRY);
    expect(err.httpStatus).toBe(422);
    expect(await prisma.protoUploadTask.count({ where: { createdBy: userId } })).toBe(before.tasks);
    expect(await prisma.protoPrototype.count({ where: { createdBy: userId } })).toBe(
      before.prototypes,
    );
    expect(await prisma.protoProject.count({ where: { createdBy: userId } })).toBe(before.projects);
    expect(await prisma.protoPrototype.count({ where: { code: prototypeCode } })).toBe(0);
    const pendingLeftovers = (await listTmp()).filter((name) => name.startsWith('upload-pending-'));
    expect(pendingLeftovers).toEqual([]);
  });

  it('原型在处理中被删除：任务失败 PROTO_NOT_FOUND，work 目录与原始包一起清理（机制 §3.2）', async () => {
    const projectId = await newProject('deleted');
    const { accepted } = await intakeCreatePrototype(projectId, `${RUN}-deleted-p01`, MINIMAL_ENTRIES);
    const taskId = BigInt(accepted.taskId);
    const prototypeId = BigInt(accepted.prototypeId);
    const task = await taskRow(taskId);
    const zipAbs = requireLocalPath(storage, String(task.tempKey));

    await prisma.protoPrototype.update({ data: { deletedAt: new Date() }, where: { id: prototypeId } });
    expect(await worker.tick()).toBe(true);

    const row = await taskRepo.findForStatus(taskId);
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe(ERROR_CODES.PROTO_NOT_FOUND);
    expect(row?.stage).toBe('committing');
    expect(row?.errorMessage).toContain('已被删除');

    // 提交在锁内发现软删就终止：版本行、事件、releases 目录都留不到，指针也停在 draft 原位。
    expect(await prisma.protoRelease.count({ where: { prototypeId } })).toBe(0);
    expect(await prisma.protoReleaseEvent.count({ where: { prototypeId } })).toBe(0);
    const prototype = await prisma.protoPrototype.findFirstOrThrow({ where: { id: prototypeId } });
    expect(prototype.status).toBe('draft');
    expect(prototype.currentReleaseId).toBeNull();
    expect(existsSync(join(storageRoot, 'releases', String(projectId), String(prototypeId)))).toBe(false);
    // §3.2 点名的"并清理 tmp"：这条失败重投必撞同一堵墙，work 目录和原始包一起删。
    expect(existsSync(join(storageRoot, 'tmp', `work-${String(taskId)}`))).toBe(false);
    expect(existsSync(zipAbs)).toBe(false);
  });
});

describe('并发取号（两个 Worker 实例共享同一测试库，FOR UPDATE SKIP LOCKED / FOR UPDATE 取号）', () => {
  it(
    '同一个包只有一个任务：两实例并发 tick，恰好一个认领，版本行只创建一条',
    async () => {
      const projectId = await newProject('race1');
      const prototypeId = await newPrototype(projectId, 'race1');
      const { accepted } = await intakeAppend(prototypeId, MINIMAL_ENTRIES, '并发首版');
      const taskId = BigInt(accepted.taskId);

      const [a, b] = await Promise.all([workerA.tick(), workerB.tick()]);
      // SKIP LOCKED 的判据：谁先锁到谁干活，另一个安静地拿 null——绝不双吃。
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await workerA.tick()).toBe(false);
      expect(await workerB.tick()).toBe(false);

      const releases = await releaseRows(prototypeId);
      expect(releases).toHaveLength(1);
      expect(releases.map((r) => r.versionNo)).toEqual([1]);
      const row = await taskRepo.findForStatus(taskId);
      expect(row?.status).toBe('success');
      expect(BigInt(accepted.prototypeId)).toBe(prototypeId);
    },
    30_000,
  );

  it(
    '同一原型两个包并发发布：两实例各认领一个，取号被 FOR UPDATE 串行化，version_no 恰好 {1,2} 无重复',
    async () => {
      const projectId = await newProject('race2');
      const prototypeId = await newPrototype(projectId, 'race2');
      const first = await intakeAppend(prototypeId, MINIMAL_ENTRIES, '并发 A');
      const second = await intakeAppend(
        prototypeId,
        [{ name: 'index.html', data: '<html><body>v2</body></html>' }],
        '并发 B',
      );

      const [a, b] = await Promise.all([workerA.tick(), workerB.tick()]);
      expect([a, b].filter(Boolean)).toHaveLength(2);
      expect(await workerA.tick()).toBe(false);
      expect(await workerB.tick()).toBe(false);

      // 每条被认领的任务都要有下落：两条都走到 success，各自的 releaseId 指向真实版本行。
      const rows = await Promise.all([
        taskRepo.findForStatus(BigInt(first.accepted.taskId)),
        taskRepo.findForStatus(BigInt(second.accepted.taskId)),
      ]);
      expect(rows.map((r) => r?.status).sort()).toEqual(['success', 'success']);
      const releases = await releaseRows(prototypeId);
      expect(releases).toHaveLength(2);
      const versions = releases.map((r) => r.versionNo);
      expect(versions).toEqual([1, 2]);
      expect(new Set(versions).size).toBe(2);
      // 两个版本各自有不可变目录，互不覆写（M3-T8「先 INSERT 拿 id 再 rename」的并发收益）。
      const dirs = releases.map((r) => requireLocalPath(storage, r.storageKey));
      expect(new Set(dirs).size).toBe(2);
      for (const dir of dirs) {
        expect(existsSync(join(dir, 'index.html'))).toBe(true);
      }
    },
    30_000,
  );

  it(
    '超时巡检重投（§3.2 Worker 崩溃路径）：processing 超 10 分钟回到 pending 并完成；第二次超时判 UPLOAD_WORKER_FAILED',
    async () => {
      const projectId = await newProject('stale');
      const prototypeA = await newPrototype(projectId, 'stale-a');
      const prototypeB = await newPrototype(projectId, 'stale-b');
      const requeued = await intakeAppend(prototypeA, MINIMAL_ENTRIES, '崩溃重投');
      const doomed = await intakeAppend(prototypeB, MINIMAL_ENTRIES, '重投用完');
      const stale = new Date(Date.now() - UPLOAD_TASK_STALE_MS - 60_000);

      // 模拟"进程被 kill"：一条 first-attempt 卡死（该重投），一条已重投过还卡死（该判死）。
      await prisma.protoUploadTask.update({
        data: { progress: 37, startedAt: stale, stage: 'extracting', status: 'processing' },
        where: { id: BigInt(requeued.accepted.taskId) },
      });
      await prisma.protoUploadTask.update({
        data: { retryCount: 1, startedAt: stale, status: 'processing' },
        where: { id: BigInt(doomed.accepted.taskId) },
      });

      const sweep = await worker.sweep();
      expect(sweep.requeued).toBeGreaterThanOrEqual(1);
      expect(sweep.failed).toBeGreaterThanOrEqual(1);
      const requeuedRow = await taskRow(BigInt(requeued.accepted.taskId));
      expect(requeuedRow.status).toBe('pending');
      expect(requeuedRow.retryCount).toBe(1);
      expect(requeuedRow.stage).toBeNull();
      expect(requeuedRow.progress).toBe(0);
      expect(requeuedRow.startedAt).toBeNull();
      const doomedRow = await taskRow(BigInt(doomed.accepted.taskId));
      expect(doomedRow.status).toBe('failed');
      expect(doomedRow.errorCode).toBe(ERROR_CODES.UPLOAD_WORKER_FAILED);
      expect(doomedRow.errorMessage).toContain('处理超时');

      // 重投的任务被再次认领后正常走完（"杀掉进程再起，processing 回到 pending 并自动完成"）。
      expect(await worker.tick()).toBe(true);
      expect((await taskRow(BigInt(requeued.accepted.taskId))).status).toBe('success');
      expect((await releaseRows(prototypeA)).map((r) => r.versionNo)).toEqual([1]);
    },
    30_000,
  );
});

describe('回填只认"自己那一次领取"（repo 不变量 2 的库侧，§3.2 的接管路径）', () => {
  /** 僵尸要写的那两种终态：值本身不重要，重要的是它们一个字符都落不到行上。 */
  const ZOMBIE_SUCCESS: SuccessPatch = {
    releaseId: 999_999n,
    stage: 'committing',
    warnings: [],
  };
  const ZOMBIE_FAILURE: FailurePatch = {
    errorCode: ERROR_CODES.UPLOAD_WORKER_FAILED,
    errorMessage: '僵尸处理者的迟到写入',
    stage: 'postprocess',
    warnings: [],
  };

  /** 取不到任务只可能是共享库里没有可认领的行——把它变成一句读得懂的失败。 */
  function mustClaim(claimed: ClaimedTask | null): ClaimedTask {
    if (claimed === null) {
      throw new Error('claim() 返回 null：本次运行的任务没在队列里（测试库被别的行占了？）');
    }
    return claimed;
  }

  it(
    '超时重投后旧令牌的三种写入全部落空，接管者的进度/阶段/归属一览不受影响',
    async () => {
      const projectId = await newProject('owner');
      const prototypeId = await newPrototype(projectId, 'owner');
      const { accepted } = await intakeAppend(prototypeId, MINIMAL_ENTRIES, '归属令牌');
      const taskId = BigInt(accepted.taskId);

      // ① 第一个处理者认领：它手里的 started_at 就是这一行"归我"的凭证。
      const first = mustClaim(await taskRepo.claim('extracting'));
      expect(first.id).toBe(taskId);

      // ② 进程被 kill：巡检把它捞回 pending 重投（§3.2），随后新处理者认领同一行。
      await prisma.protoUploadTask.update({
        data: { startedAt: new Date(Date.now() - UPLOAD_TASK_STALE_MS - 60_000) },
        where: { id: taskId },
      });
      await worker.sweep();
      expect((await taskRow(taskId)).status).toBe('pending');
      // `started_at` 是毫秒精度：真实重投至少要隔过 10 分钟的超时界，两个令牌不可能同值；
      // 这里靠一次短等待把"同毫秒领取"这个测试专属的歧义去掉，下面的不等式才有意义。
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      const second = mustClaim(await taskRepo.claim('extracting'));
      expect(second.id).toBe(taskId);
      expect(second.retryCount).toBe(1);
      // 重投把 started_at 清成 null、再领取时写的是新时刻：两个令牌必须真的不是同一个值。
      expect(second.ownership.startedAt.getTime()).toBeGreaterThan(
        first.ownership.startedAt.getTime(),
      );

      // ③ 僵尸醒来补写：进度、失败终态、成功终态三种都该匹配不到行。
      await expect(taskRepo.patchProgress(first.ownership, 'postprocess', 60)).resolves.toBe(false);
      await expect(taskRepo.markFailure(first.ownership, ZOMBIE_FAILURE)).resolves.toBe(false);
      await expect(taskRepo.markSuccess(first.ownership, ZOMBIE_SUCCESS)).resolves.toBe(false);

      // ④ 行还是接管者刚领到的样子：进度停在区间下界、没有终态、没有错误、started_at 是新的那个。
      const afterZombie = await taskRow(taskId);
      expect(afterZombie).toMatchObject({
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        progress: stageStartProgress('extracting'),
        releaseId: null,
        retryCount: 1,
        stage: 'extracting',
        startedAt: second.ownership.startedAt,
        status: 'processing',
      });

      // ⑤ 停的是僵尸，不是接管者：同一个时刻用新令牌写入照常生效。
      await expect(taskRepo.patchProgress(second.ownership, 'postprocess', 61)).resolves.toBe(true);
      expect((await taskRow(taskId)).progress).toBe(61);

      // 收尾：本次运行不给共享库留 processing 行——用新令牌判它失败（终态写只认归属）。
      await expect(taskRepo.markFailure(second.ownership, ZOMBIE_FAILURE)).resolves.toBe(true);
      expect((await taskRow(taskId)).status).toBe('failed');
    },
    30_000,
  );
});

describe('失败重试复用 draft 原型（M3-T11 的服务端侧，机制 §3.0 理由②）', () => {
  it(
    '失败留下 draft：带 prototypeId 重发不再新建原型行，复用同一 id 直到发布成功',
    async () => {
      const projectId = await newProject('retry');
      const { accepted } = await intakeCreatePrototype(projectId, `${RUN}-retry-p01`, LYING_ENTRY_ENTRIES);
      const prototypeId = BigInt(accepted.prototypeId);

      expect(await worker.tick()).toBe(true);
      expect((await taskRow(BigInt(accepted.taskId))).status).toBe('failed');
      // 失败不改原型状态：draft 本来允许存在，这正是"表单不用重填"的库侧依据（§3.0）。
      const afterFail = await prisma.protoPrototype.findFirstOrThrow({ where: { id: prototypeId } });
      expect(afterFail.status).toBe('draft');
      expect(await prisma.protoPrototype.count({ where: { projectId } })).toBe(1);

      const retry = await intakeAppend(prototypeId, MINIMAL_ENTRIES, '重试版本');
      expect(retry.accepted.prototypeId).toBe(accepted.prototypeId);
      expect(retry.accepted.projectId).toBe(accepted.projectId);
      expect(await prisma.protoPrototype.count({ where: { projectId } })).toBe(1);

      expect(await worker.tick()).toBe(true);
      const done = await prisma.protoPrototype.findFirstOrThrow({ where: { id: prototypeId } });
      expect(done.status).toBe('published');
      expect(done.currentReleaseId).not.toBeNull();
      const releases = await releaseRows(prototypeId);
      expect(releases).toHaveLength(1);
      expect(releases[0]?.versionNo).toBe(1);
      // 两条任务都如实在场：失败那条不会被重试动作改写。
      const tasks = await prisma.protoUploadTask.findMany({
        orderBy: { id: 'asc' },
        where: { prototypeId },
      });
      expect(tasks.map((t) => t.status)).toEqual(['failed', 'success']);
    },
    30_000,
  );
});

/** 原始包 sha256（§2.7 source_hash 的口径：打在上传 zip 上）。 */
function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * GC 集成测试（机制 §4.3；迭代实施计划 M5-T6 的六条判据 = Gate G3）。
 *
 * 跑在真库 `protohub_test` + 真临时目录上：这六条判据全是"记录与磁盘对不对得上"，
 * 用桩就等于没验。隔离方式与 `dashboard.overview.spec` 同款——RUN 随机后缀圈住自己的行、
 * 收尾只删自己建的，绝不 truncate；`KEEP_MIN_DAYS` 的时间兜底又保证 GC 不会碰到别人的行
 * （别人的行都是今天建的，永远在保留窗口内）。
 */
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@protohub/db';

import {
  assertTestDatabase,
  databaseNameOf,
} from '../../../../../packages/db/src/seed/guard';

import { AppEnvService } from '../../config/app-env.service';
import { LocalStorageAdapter } from '../storage/local-storage.adapter';
import { releaseKey, TMP_PREFIX, TRASH_PREFIX } from '../storage/storage-keys';
import { GcService } from './gc.service';
import { fakeAppEnv } from '../../testing/app-env.fixture';

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

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const DAY_MS = 86_400_000;

let prisma: PrismaClient;
let storage: LocalStorageAdapter;
let env: AppEnvService;
let gc: GcService;
let root = '';
let userId = 0n;
const projectIds: bigint[] = [];
const prototypeIds: bigint[] = [];

/** 每个用例自己的项目/原型（带 RUN 后缀，别人看不进也碰不到） */
async function makeProject(name: string): Promise<bigint> {
  const row = await prisma.protoProject.create({
    data: { code: `gc-${RUN}-${name}`.slice(0, 63), createdBy: userId, name: `GC ${name} ${RUN}` },
  });
  projectIds.push(row.id);
  return row.id;
}

async function makePrototype(projectId: bigint, name: string): Promise<bigint> {
  const row = await prisma.protoPrototype.create({
    data: {
      code: `p-${name}`.slice(0, 63),
      createdBy: userId,
      name: `GC原型 ${name}`,
      projectId,
    },
  });
  prototypeIds.push(row.id);
  return row.id;
}

/**造一个版本行 + 盘上同名目录（内容 1KB，方便算"释放字节数"） */
async function makeRelease(
  projectId: bigint,
  prototypeId: bigint,
  versionNo: number,
  options: { ageDays?: number; deletedAtDaysAgo?: number } = {},
): Promise<{ id: bigint; key: string }> {
  const ageDays = options.ageDays ?? 0;
  const createdAt = new Date(Date.now() - ageDays * DAY_MS);
  const row = await prisma.protoRelease.create({
    data: {
      contentHash: `gc-${RUN}-${String(prototypeId)}-${String(versionNo)}`,
      createdAt,
      createdBy: userId,
      deletedAt:
        options.deletedAtDaysAgo === undefined
          ? null
          : new Date(Date.now() - options.deletedAtDaysAgo * DAY_MS),
      fileCount: 1,
      prototypeId,
      sourceHash: `src-${RUN}-${String(prototypeId)}-${String(versionNo)}`,
      sourceSize: 1024,
      status: options.deletedAtDaysAgo === undefined ? 'ready' : 'deleted',
      storageKey: '',
      totalBytes: 1024,
      versionNo,
    },
  });
  const key = releaseKey(String(projectId), String(prototypeId), String(row.id));
  await prisma.protoRelease.update({ data: { storageKey: key }, where: { id: row.id } });
  await writeStorageDir(key);
  return { id: row.id, key };
}

/** 在存储里造一个目录 + 一个 1KB 文件 */
async function writeStorageDir(key: string, ageMs = 0): Promise<void> {
  const abs = join(root, key);
  await mkdir(abs, { recursive: true });
  await writeFile(join(abs, 'index.html'), Buffer.alloc(1024, 1));
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    await utimes(join(abs, 'index.html'), at, at);
    await utimes(abs, at, at);
  }
}

async function existsOnDisk(key: string): Promise<boolean> {
  try {
    await stat(join(root, key));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  prisma = createPrismaClient(targetUrl);
  root = await mkdtemp(join(tmpdir(), 'protohub-gc-'));
  env = fakeAppEnv({ STORAGE_ROOT: root });
  storage = new LocalStorageAdapter(env);
  await storage.onModuleInit();
  gc = new GcService(prisma, storage, env);

  const user = await prisma.sysUser.create({
    data: {
      passwordHash: 'not-a-real-hash',
      realName: `GC ${RUN}`,
      status: 1,
      username: `gc-${RUN}`,
    },
  });
  userId = user.id;
});

afterAll(async () => {
  const prototypeIdList = prototypeIds.length > 0 ? { in: prototypeIds } : undefined;
  await prisma.protoUploadTask.deleteMany({ where: { prototypeId: prototypeIdList } });
  await prisma.protoAccessLog.deleteMany({ where: { prototypeId: prototypeIdList } });
  await prisma.protoRelease.deleteMany({ where: { prototypeId: prototypeIdList } });
  await prisma.protoPrototype.deleteMany({
    where: { id: prototypeIds.length > 0 ? { in: prototypeIds } : undefined },
  });
  await prisma.protoProject.deleteMany({
    where: { id: projectIds.length > 0 ? { in: projectIds } : undefined },
  });
  await prisma.sysUser.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
  await rm(root, { force: true, recursive: true });
});

describe('GcService（机制 §4.3）', () => {
  it('判据 1：一个原型 8 个版本（保留 5）→ 最旧 3 个标 deleted，当前生效版本没被动过', async () => {
    const project = await makeProject('keep5');
    const prototype = await makePrototype(project, 'keep5');
    const made: Array<{ id: bigint; key: string }> = [];
    for (let versionNo = 1; versionNo <= 8; versionNo += 1) {
      // 全部造得比 KEEP_MIN_DAYS 还老，否则时间兜底会把它们全留住
      made.push(await makeRelease(project, prototype, versionNo, { ageDays: 40 }));
    }
    await prisma.protoPrototype.update({
      data: { currentReleaseId: made[7]!.id },
      where: { id: prototype },
    });

    const summary = await gc.runOnce();
    expect(summary.markedDeleted).toBe(3);

    const rows = await prisma.protoRelease.findMany({
      orderBy: { versionNo: 'asc' },
      select: { deletedAt: true, id: true, status: true, versionNo: true },
      where: { prototypeId: prototype },
    });
    const deleted = rows.filter((row) => row.status === 'deleted');
    expect(deleted.map((row) => row.versionNo)).toEqual([1, 2, 3]);
    // 当前生效版本（v8）原样：没标 deleted、deletedAt 仍是 null
    const current = rows.find((row) => row.id === made[7]!.id);
    expect(current?.status).toBe('ready');
    expect(current?.deletedAt).toBeNull();
    // 目录还在盘上：标 deleted 只是标记，物理删除走的是满 7 天那一步
    expect(await existsOnDisk(made[0]!.key)).toBe(true);
  });

  it('判据 2：同项目 20 个原型各 2 个版本 → 一个都不删（保留计数按原型算）', async () => {
    const project = await makeProject('twenty');
    for (let index = 0; index < 20; index += 1) {
      const prototype = await makePrototype(project, `t${String(index)}`);
      await makeRelease(project, prototype, 1, { ageDays: 40 });
      await makeRelease(project, prototype, 2, { ageDays: 40 });
    }
    const summary = await gc.runOnce();
    expect(summary.markedDeleted).toBe(0);
  });

  it('判据 3：标记满 7 天 → 目录移入 trash；trash 再满 7 天 → 物理删除', async () => {
    const project = await makeProject('trash');
    const prototype = await makePrototype(project, 'trash');
    const old = await makeRelease(project, prototype, 1, {
      ageDays: 40,
      deletedAtDaysAgo: 8,
    });

    const first = await gc.runOnce();
    expect(first.movedToTrash).toBeGreaterThanOrEqual(1);
    expect(await existsOnDisk(old.key)).toBe(false);
    const trashed = await storage.listPrefix(TRASH_PREFIX);
    expect(trashed.some((entry) => entry.sizeBytes > 0)).toBe(true);

    // 把 trash 里的东西改成"已经躺了 8 天"，下一轮就该物理删掉
    for (const entry of trashed) {
      await writeStorageDir(entry.key, 8 * DAY_MS);
    }
    const second = await gc.runOnce();
    expect(second.dirsRemoved).toBeGreaterThanOrEqual(1);
    expect((await storage.listPrefix(TRASH_PREFIX)).length).toBe(0);
  });

  it('判据 4：releases/ 下 DB 里不存在的目录、mtime 超过 1 小时 → 移入 trash', async () => {
    const project = await makeProject('orphan');
    const prototype = await makePrototype(project, 'orphan');
    const orphanKey = releaseKey(
      String(project),
      String(prototype),
      '999999',
    );
    await writeStorageDir(orphanKey, 2 * 3_600_000);

    // 刚造出来的不算孤儿（给"先 rename 再写库"留窗口）
    const freshKey = releaseKey(String(project), String(prototype), '999998');
    await writeStorageDir(freshKey, 60_000);

    await gc.runOnce();
    expect(await existsOnDisk(orphanKey)).toBe(false);
    expect(await existsOnDisk(freshKey)).toBe(true);
  });

  it('判据 5：跑一半被打断也能续上——连跑两轮幂等，不重复删、不报错', async () => {
    const project = await makeProject('idempotent');
    const prototype = await makePrototype(project, 'idempotent');
    await makeRelease(project, prototype, 1, {
      ageDays: 40,
      deletedAtDaysAgo: 8,
    });
    await writeStorageDir(join(TMP_PREFIX, `work-${RUN}`), 2 * DAY_MS);

    const first = await gc.runOnce();
    const second = await gc.runOnce();
    // 第二轮不该再把同一批东西删一遍（能删的都删完了）
    expect(first.tmpRemoved).toBeGreaterThanOrEqual(1);
    expect(second.movedToTrash).toBe(0);
    expect(second.tmpRemoved).toBe(0);
    expect(second.markedDeleted).toBe(0);
  });

  it('判据 6：每轮都出 summary（删除目录数 / 释放字节数 / 磁盘余量）', async () => {
    const summary = await gc.runOnce();
    expect(typeof summary.startedAt).toBe('string');
    expect(summary.dirsRemoved).toBeGreaterThanOrEqual(0);
    expect(summary.bytesFreed).toBeGreaterThanOrEqual(0);
    // 磁盘余量取不到就给 null（文件系统不支持 statfs 时不判失败），取到了必须是正数
    if (summary.freeDiskBytes !== null) {
      expect(summary.freeDiskBytes).toBeGreaterThan(0);
    }
  });
});

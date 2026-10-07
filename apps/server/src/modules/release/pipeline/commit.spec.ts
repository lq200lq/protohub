import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import {
  RELEASE_COMMIT_TX_TIMEOUT_MS,
  RELEASE_VERSION_MAX_RETRY,
} from '../../../config/constants';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import { LocalStorageAdapter } from '../../storage/local-storage.adapter';
import {
  PrototypeDeletedError,
  ReleaseCommitter,
  type CommitInput,
  type CommitResult,
} from './commit';
import type { ReleaseManifest } from './postprocess';

/**
 * 提交阶段单测（机制 §3.1/§3.2/§2.7，计划 M3-T8 判据）。
 *
 * 钉的是三件只有这一层负责、且不看流水就发现不了的事：
 * 1. **顺序不能反**：八条动作记进一条 ops 流水，第一个用例直接比对整条序列——那就是判据本身。
 * 2. **禁止用 `max(id)+1` 猜 id**：`releaseId` 只能来自 `INSERT … RETURNING id`，所以除了正向
 *    比对返回值，还反过来扫全部 SQL，出现 `max(id)` 就判失败。
 * 3. **落盘先于写库**：rename 一失败，后面四条库写一条都不许发生。
 *
 * 真磁盘用真 `LocalStorageAdapter` + 临时根目录，所以"目录真的被 rename 走了""清单副本真的落盘了"
 * 是量出来的而不是猜的；Prisma 用假事务客户端桩掉——`FOR UPDATE` 真的串行化、唯一索引真的兜底
 * 这两件事属于 M3-T16 的集成测试。
 */

const P2002 = Object.assign(new Error('Unique constraint failed on uk_proto_release_version'), {
  code: 'P2002',
});

const PROJECT_ID = 9n;
const PROTOTYPE_ID = 31n;
const SOURCE_HASH = 'a'.repeat(64);
const CONTENT_HASH = 'b'.repeat(64);
/** 假库第一次 `RETURNING id` 给的值；自增序列在此之后每次 +1，永不回退。 */
const FIRST_RELEASE_ID = 77n;

/** §3.1 那张单子上八条动作的名字：断言与实现读同一份，不靠字面量各抄一遍。 */
const ORDER = {
  backfillKey: '回填 storage_key',
  event: '写事件',
  insert: '插版本行',
  lock: '锁原型行',
  manifest: '写清单副本',
  pointer: '切指针',
  rename: 'rename 进 releases',
  version: '取版本号',
} as const;

const MANIFEST: ReleaseManifest = {
  entry: 'index.html',
  fileCount: 2,
  files: [
    { p: 'assets/app.js', sha256: 'd'.repeat(64), size: 100 },
    { p: 'index.html', sha256: 'c'.repeat(64), size: 200 },
  ],
  rewrites: { css: 0, html: 3 },
  skipped: [],
  totalBytes: 300,
  warnings: [],
};

interface LockRow {
  current_release_id: null | bigint;
  deleted_at: null | Date;
}

interface HarnessOptions {
  /** 前 N 次 INSERT 抛 `uk_proto_release_version` 冲突（模拟并发取号撞车）。 */
  readonly insertConflicts?: number;
  /** `FOR UPDATE` 查原型行的返回值：`[]` 模拟行已被级联物理删掉。 */
  readonly lockRows?: LockRow[];
  /** `moveIntoService` 抛的错误：模拟盘出问题。 */
  readonly renameError?: Error;
  /** `COALESCE(max(version_no),0)+1` 的返回值。 */
  readonly versionNo?: number;
}

interface RecordedSql {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface Harness {
  readonly allOpsInsideTransaction: () => boolean;
  readonly commits: () => CommitResult[];
  readonly eventCreates: Array<Record<string, unknown>>;
  /** 第 N 次 `INSERT … RETURNING id` 里按列名配好的参数。 */
  readonly insertParams: (nth?: number) => Record<string, unknown>;
  readonly ops: string[];
  readonly releaseUpdates: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }>;
  readonly root: string;
  readonly run: () => Promise<CommitResult>;
  readonly sqls: RecordedSql[];
  readonly timeoutUsed: () => number;
  readonly transactions: () => number;
  readonly workDir: string;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-commit-'));
  const adapter = new LocalStorageAdapter(fakeAppEnv({ STORAGE_ROOT: root }));
  const workDir = join(root, 'tmp', 'work-128');
  await mkdir(workDir, { recursive: true });
  await writeFile(join(workDir, 'index.html'), '<main>ok</main>', 'utf8');

  const ops: string[] = [];
  const sqls: RecordedSql[] = [];
  const eventCreates: Array<Record<string, unknown>> = [];
  const releaseUpdates: Harness['releaseUpdates'] = [];
  const done: CommitResult[] = [];
  const timeouts: number[] = [];
  const inside = { value: false };
  const allInside = { value: true };
  let releaseIdSeq = FIRST_RELEASE_ID;
  let conflictsLeft = options.insertConflicts ?? 0;
  let transactionCount = 0;

  const record = (name: string): void => {
    ops.push(name);
    if (!inside.value) {
      allInside.value = false;
    }
  };

  const client = {
    protoRelease: {
      update: async (args: { data: Record<string, unknown>; where: Record<string, unknown> }) => {
        releaseUpdates.push(args);
        record(ORDER.backfillKey);
        return { id: 1n };
      },
    },
    protoReleaseEvent: {
      create: async (args: { data: Record<string, unknown> }) => {
        eventCreates.push(args.data);
        record(ORDER.event);
        return { id: 1n };
      },
    },
    // 真 Prisma 的 `$queryRaw` / `$executeRaw` 是标签模板：第一个参数是字面量数组，
    // 插值按剩余位置参数进来（`strings.join('?')` 还原成带占位符的 SQL）。
    $executeRaw: async (
      strings: readonly string[],
      ...values: unknown[]
    ): Promise<number> => {
      sqls.push({ sql: strings.join('?'), values });
      record(ORDER.pointer);
      return 1;
    },
    $queryRaw: async (
      strings: readonly string[],
      ...values: unknown[]
    ): Promise<unknown> => {
      const sql = strings.join('?');
      sqls.push({ sql, values });
      if (sql.includes('for update')) {
        record(ORDER.lock);
        return options.lockRows ?? [{ current_release_id: null, deleted_at: null }];
      }
      if (sql.includes('max(version_no)')) {
        record(ORDER.version);
        return [{ next: options.versionNo ?? 1 }];
      }
      record(ORDER.insert);
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        throw P2002;
      }
      const id = releaseIdSeq;
      releaseIdSeq += 1n;
      return [{ id }];
    },
  };

  // commit 只用到这两个存储入口（`StorageAdapter` 的其余方法在这里没有位置）。
  const storage = {
    moveIntoService: async (localPath: string, key: string): Promise<void> => {
      record(ORDER.rename);
      if (options.renameError !== undefined) {
        throw options.renameError;
      }
      await adapter.moveIntoService(localPath, key);
    },
    putFile: async (localPath: string, key: string): Promise<void> => {
      record(ORDER.manifest);
      await adapter.putFile(localPath, key);
    },
  };

  const committer = new ReleaseCommitter(
    {
      $transaction: async (
        work: (tx: typeof client) => Promise<CommitResult>,
        txOptions?: { timeout?: number },
      ): Promise<CommitResult> => {
        transactionCount += 1;
        timeouts.push(txOptions?.timeout ?? -1);
        inside.value = true;
        try {
          const result = await work(client);
          done.push(result);
          return result;
        } finally {
          inside.value = false;
        }
      },
    } as never,
    storage as never,
  );

  const input: CommitInput = {
    contentHash: CONTENT_HASH,
    createdBy: 4n,
    entry: 'index.html',
    manifest: MANIFEST,
    note: '改了配色',
    projectId: PROJECT_ID,
    prototypeId: PROTOTYPE_ID,
    sourceHash: SOURCE_HASH,
    sourceSize: 2048,
    workDir,
  };

  return {
    allOpsInsideTransaction: () => allInside.value,
    commits: () => [...done],
    eventCreates,
    insertParams: (nth = 0) => insertParamsOf(sqls, nth),
    ops,
    releaseUpdates,
    root,
    run: () => committer.commit(input),
    sqls,
    timeoutUsed: () => timeouts[0] ?? -1,
    transactions: () => transactionCount,
    workDir,
  };
}

/** 把 INSERT 的列名与占位值配起来，好按名字断言（换列顺序、值错位都会立刻暴露）。 */
function insertParamsOf(sqls: readonly RecordedSql[], nth: number): Record<string, unknown> {
  const inserts = sqls.filter((entry) => entry.sql.includes('insert into proto_release'));
  const insert = inserts[nth];
  if (insert === undefined) {
    throw new Error(`只有 ${String(inserts.length)} 条 INSERT proto_release`);
  }
  const listed = /insert into proto_release \(([\s\S]*?)\)\s*values/u.exec(insert.sql);
  // `'ready'` 是 SQL 里的字面量，不占位，所以配值时要跳过它。
  const columns = (listed?.[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '' && name !== 'status');
  return Object.fromEntries(columns.map((name, index) => [name, insert.values[index] ?? null]));
}

function allSqlText(sqls: readonly RecordedSql[]): string {
  return sqls.map((entry) => entry.sql).join('\n');
}

function pointerSql(sqls: readonly RecordedSql[]): RecordedSql {
  const update = sqls.find((entry) => entry.sql.includes('update proto_prototype'));
  if (update === undefined) {
    throw new Error('没有 UPDATE proto_prototype 语句');
  }
  return update;
}

describe('§3.1 的提交顺序（计划 M3-T8 判据：顺序不能反）', () => {
  it('八条动作严格按 锁行 → 取号 → 插行 → rename → 清单 → 回填 → 切指针 → 事件', async () => {
    const h = await createHarness();

    await h.run();

    expect(h.ops).toEqual([
      ORDER.lock,
      ORDER.version,
      ORDER.insert,
      ORDER.rename,
      ORDER.manifest,
      ORDER.backfillKey,
      ORDER.pointer,
      ORDER.event,
    ]);
    expect(h.transactions()).toBe(1);
  });

  it('落盘也在事务之内：不会留下"库里宣称成功、磁盘上没东西"的版本', async () => {
    const h = await createHarness();

    await h.run();

    expect(h.allOpsInsideTransaction()).toBe(true);
  });

  it('id 只能问库要：出现 max(id) 猜测就是判据失败', async () => {
    const h = await createHarness();

    await h.run();

    expect(allSqlText(h.sqls)).toMatch(/returning\s+id/u);
    expect(allSqlText(h.sqls)).not.toMatch(/max\s*\(\s*"?id"?\s*\)/u);
    expect(h.commits()[0]?.releaseId).toBe(FIRST_RELEASE_ID);
  });

  it('rename 一失败，后面四条库写一条都不发生（先落盘、后写库）', async () => {
    const diskFull = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    const h = await createHarness({ renameError: diskFull });

    await expect(h.run()).rejects.toBe(diskFull);

    expect(h.ops).toEqual([ORDER.lock, ORDER.version, ORDER.insert, ORDER.rename]);
    expect(h.releaseUpdates).toHaveLength(0);
    expect(h.eventCreates).toHaveLength(0);
    // 失败路径不在这里清盘：工作目录与半截产物交给 Worker 与 GC（§4.3 的 tmp 规则）。
    expect(existsSync(h.workDir)).toBe(true);
    expect(h.transactions()).toBe(1);
  });

  it('事务超时上限显式给出：默认 5 秒装不下"事务里夹两次落盘"', async () => {
    const h = await createHarness();

    await h.run();

    expect(h.timeoutUsed()).toBe(RELEASE_COMMIT_TX_TIMEOUT_MS);
  });
});

describe('§3.1 第 2 步与 §2.7 的落盘结果（真磁盘量出来的）', () => {
  it('工作目录整体 rename 成 releases/{项目ID}/{原型ID}/{版本ID}，原位不再存在', async () => {
    const h = await createHarness();

    const result = await h.run();

    expect(result.storageKey).toBe(`releases/9/31/${String(FIRST_RELEASE_ID)}`);
    expect(existsSync(join(h.root, result.storageKey, 'index.html'))).toBe(true);
    expect(await readFile(join(h.root, result.storageKey, 'index.html'), 'utf8')).toBe(
      '<main>ok</main>',
    );
    expect(existsSync(h.workDir)).toBe(false);
  });

  it('清单副本落在 manifests/{原型ID}/{版本ID}.json，与库里那份 jsonb 是同一串字节', async () => {
    const h = await createHarness();

    await h.run();

    const copied = await readFile(
      join(h.root, 'manifests', '31', `${String(FIRST_RELEASE_ID)}.json`),
      'utf8',
    );
    expect(copied).toBe(String(h.insertParams().manifest));
    expect(JSON.parse(copied)).toMatchObject({ entry: 'index.html', fileCount: 2 });
  });

  it('清单临时文件用完即删，不会留在 tmp 里冒充产物', async () => {
    const h = await createHarness();

    await h.run();

    expect(existsSync(`${h.workDir}.manifest.json`)).toBe(false);
  });

  it('上一次崩在中间留下的清单临时文件会被覆盖，而不是污染本次副本', async () => {
    const h = await createHarness();
    await writeFile(`${h.workDir}.manifest.json`, '{"entry":"半截文件"', 'utf8');

    await h.run();

    const copied = await readFile(
      join(h.root, 'manifests', '31', `${String(FIRST_RELEASE_ID)}.json`),
      'utf8',
    );
    expect(copied).toBe(JSON.stringify(MANIFEST));
  });
});

describe('§3.1 c/d/e 三条写库的内容', () => {
  it('版本行：status=ready、storage_key 先写父前缀、大小与计数取自清单、指纹两枚各归各位', async () => {
    const h = await createHarness();

    await h.run();

    const params = h.insertParams();
    expect(params).toEqual({
      content_hash: CONTENT_HASH,
      created_by: 4n,
      entry_file: 'index.html',
      file_count: 2,
      manifest: JSON.stringify(MANIFEST),
      note: '改了配色',
      prototype_id: PROTOTYPE_ID,
      source_hash: SOURCE_HASH,
      source_size: 2048n,
      storage_key: 'releases/9/31/',
      total_bytes: 300n,
      version_no: 1,
    });
    expect(h.sqls.find((entry) => entry.sql.includes('insert into proto_release'))?.sql).toContain(
      "'ready'",
    );
  });

  it('回填：把完整 key 写回这一行，而不是留给下次', async () => {
    const h = await createHarness();

    await h.run();

    expect(h.releaseUpdates).toEqual([
      {
        data: { storageKey: `releases/9/31/${String(FIRST_RELEASE_ID)}` },
        where: { id: FIRST_RELEASE_ID },
      },
    ]);
  });

  it('切指针：published_at 每次前进、first_published_at 只落一次、当前版本指向新行', async () => {
    const h = await createHarness();

    await h.run();

    const update = pointerSql(h.sqls);
    expect(update.values).toEqual([FIRST_RELEASE_ID, 4n, PROTOTYPE_ID]);
    expect(update.sql).toContain('current_release_id = ?');
    expect(update.sql).toMatch(/first_published_at\s*=\s*coalesce\s*\(\s*first_published_at,\s*now\(\)\s*\)/u);
    expect(update.sql).toMatch(/published_at\s*=\s*now\(\)/u);
  });

  it('归档（已下架）不会因为一次发布被悄悄翻回上架：§5.1 那条规则不留异步缺口', async () => {
    const h = await createHarness();

    await h.run();

    expect(pointerSql(h.sqls).sql).toMatch(
      /status\s*=\s*case\s+when\s+status\s*=\s*'archived'\s+then\s+status\s+else\s+'published'\s+end/u,
    );
  });

  it('事件行：publish + from 上一版 + to 新版 + 操作人 + reason 用版本说明', async () => {
    const h = await createHarness({
      lockRows: [{ current_release_id: 76n, deleted_at: null }],
      versionNo: 4,
    });

    const result = await h.run();

    expect(result.versionNo).toBe(4);
    expect(h.eventCreates).toEqual([
      {
        eventType: 'publish',
        fromReleaseId: 76n,
        operatorId: 4n,
        prototypeId: PROTOTYPE_ID,
        reason: '改了配色',
        toReleaseId: FIRST_RELEASE_ID,
      },
    ]);
  });
});

describe('§3.2 的并发与"发布过程中原型被删除"', () => {
  it('原型已软删 → PROTO_NOT_FOUND，锁之后一条库写都没发生、目录原样留着', async () => {
    const h = await createHarness({
      lockRows: [{ current_release_id: 76n, deleted_at: new Date() }],
    });

    const failure: unknown = await h.run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PrototypeDeletedError);
    expect(failure).toMatchObject({
      code: ERROR_CODES.PROTO_NOT_FOUND,
      prototypeId: PROTOTYPE_ID,
    });
    expect(h.ops).toEqual([ORDER.lock]);
    expect(h.releaseUpdates).toHaveLength(0);
    // tmp 的清理归 Worker（§3.2 那句"并清理 tmp"是它的职责，不是这一层的）。
    expect(existsSync(h.workDir)).toBe(true);
  });

  it('原型行已被级联物理删掉（查不到行）→ 同一个错，不猜', async () => {
    const h = await createHarness({ lockRows: [] });

    await expect(h.run()).rejects.toBeInstanceOf(PrototypeDeletedError);
    expect(h.ops).toEqual([ORDER.lock]);
  });

  it('版本号撞唯一索引 → 整个事务从头重跑（不是接着上一条语句走）', async () => {
    const h = await createHarness({ insertConflicts: 1 });

    const result = await h.run();

    expect(h.transactions()).toBe(2);
    expect(h.ops).toEqual([
      ORDER.lock,
      ORDER.version,
      ORDER.insert,
      ORDER.lock,
      ORDER.version,
      ORDER.insert,
      ORDER.rename,
      ORDER.manifest,
      ORDER.backfillKey,
      ORDER.pointer,
      ORDER.event,
    ]);
    expect(result.releaseId).toBe(FIRST_RELEASE_ID);
  });

  it('连撞上限 → 如实报失败并说清下一步，且不再多试一次', async () => {
    const h = await createHarness({ insertConflicts: RELEASE_VERSION_MAX_RETRY + 2 });

    await expect(h.run()).rejects.toMatchObject({
      errorCode: ERROR_CODES.UPLOAD_WORKER_FAILED,
      message: `同一原型连续 ${String(RELEASE_VERSION_MAX_RETRY)} 次抢版本号失败，请稍后重新发布`,
    });
    expect(h.transactions()).toBe(RELEASE_VERSION_MAX_RETRY);
  });
});

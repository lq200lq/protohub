import type { Prisma, PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ERROR_CODES,
  UPLOAD_WARNING_CODES,
  type UploadTaskStage,
  type UploadTaskWarning,
} from '@protohub/shared';

import { stageStartProgress } from '../pipeline/progress';
import {
  UploadTaskRepo,
  type ClaimedTask,
  type ClaimOwnership,
  type FailurePatch,
  type SuccessPatch,
} from './upload-task.repo';

/**
 * 发布任务队列的取 / 回填 / 巡检单测（机制 §3.3 + §3.2，计划 M3-T4 的 repo 半边）。
 *
 * Prisma 在客户端边界桩掉（同 `release.repo.spec.ts`），钉的是**只有这一层负责**、
 * 且不看流水就发现不了的三件不变量（文件头那三条）：
 * 1. 取到即占：选中 + 置 `processing` 必须在同一个 `$transaction` 回调里（锁随事务释放）；
 * 2. 回填只认"自己那一次领取"：每条进度/终态写入的 `where` 都带 `status='processing'` **且**
 *    `started_at = 本次领取写入的那个时刻`。光有 status 挡不住僵尸处理者——巡检把行捞回
 *    `pending`、接管者再置回 `processing` 之后，迟到写入照样匹配得上，于是进度倒退、
 *    接管者正在跑的任务被判成 failed；带上 started_at 才真的"不是我的行就写不动"；
 * 3. 重投只有一次：上界写在巡检那两条 SQL 的 `retry_count` 条件里，终态写入自己不动这一列。
 *
 * `FOR UPDATE SKIP LOCKED` 真的互不咬行、`version_no` 取号、一次重投之后旧令牌的写入真的落空
 * ——要到库里才验得，归 M3-T16 集成测试；这里只钉"发出去的语句与参数就是那一句"。Worker 侧的行为（停手、清盘、日志）在
 * `upload-worker.service.spec.ts`，本层也不碰 release/prototype 两张表（§3.3 的分工）。
 */

const TASK_ID = 128n;
const PROJECT_ID = 9n;
const PROTOTYPE_ID = 31n;
const RELEASE_ID = 77n;
/** 假时钟冻住的那一刻：`started_at`/`finished_at` 都该等于它。 */
const FROZEN_AT = new Date('2026-10-06T10:00:00.000Z');
/** 这一次领取的归属令牌：所有回填都该按它定位行（不变量 2）。 */
const OWNERSHIP: ClaimOwnership = { startedAt: FROZEN_AT, taskId: TASK_ID };

/** §2.7 那份发布报告的两条：一条不带计数、一条带。 */
const UNWRAP: UploadTaskWarning = {
  code: UPLOAD_WARNING_CODES.UNWRAP_SINGLE_TOP_DIR,
  message: '已自动上提目录「proto2」，入口为 index.html',
};
const REWRITE: UploadTaskWarning = {
  code: UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH,
  count: 12,
  message: '已将 12 处根绝对路径改写为 /p/crm/crm-p01/ 前缀（HTML 9 处，CSS 3 处）',
};

/** 候选查询那一句：`pending` + 排队顺序 + 一条 + 抢占式锁，四样缺一不可。 */
const CLAIM_SELECT_SQL =
  "select id from proto_upload_task where status = 'pending' order by created_at, id limit 1 for update skip locked";

/** 巡检第一条：已经重投过一次的那批直接判失败（§3.2「第二次仍失败则置 failed」）。 */
const STALE_FAILED_SQL =
  "update proto_upload_task set status = 'failed', finished_at = now(), " +
  "error_code = 'UPLOAD_WORKER_FAILED', error_message = " +
  "'处理超时，已自动重试一次仍未完成；请重新发布，或把 traceId 提供给运维' " +
  "where status = 'processing' and started_at < ? and retry_count >= ?";

/** 巡检第二条：还没到重投上界的那批回到队列头，并把停在半路的显示字段清干净。 */
const STALE_REQUEUED_SQL =
  "update proto_upload_task set status = 'pending', started_at = null, stage = null, " +
  "progress = 0, retry_count = retry_count + 1 " +
  "where status = 'processing' and started_at < ? and retry_count < ?";

/** `claim()` 那次 `include` 读回来的形状：只列这一层真正会读的字段。 */
interface ClaimEntity {
  readonly createdBy: bigint;
  readonly id: bigint;
  readonly note: null | string;
  readonly prototype: {
    readonly code: string;
    readonly id: bigint;
    readonly project: { readonly code: string; readonly id: bigint };
  };
  readonly prototypeId: bigint;
  readonly retryCount: number;
  readonly sourceName: string;
  readonly sourceSize: bigint;
  readonly tempKey: null | string;
}

/** `findForStatus()` 那份 select 读回来的形状（列名与 `TASK_STATUS_SELECT` 对齐）。 */
interface StatusEntity {
  readonly errorCode: null | string;
  readonly errorMessage: null | string;
  readonly id: bigint;
  readonly progress: number;
  readonly prototype: {
    readonly code: string;
    readonly id: bigint;
    readonly project: { readonly code: string; readonly id: bigint };
  };
  readonly prototypeId: bigint;
  readonly releaseId: null | bigint;
  readonly sourceName: string;
  readonly sourceSize: bigint;
  readonly stage: null | string;
  readonly status: string;
  readonly warnings: Prisma.JsonValue;
}

const CLAIM_ENTITY: ClaimEntity = {
  createdBy: 4n,
  id: TASK_ID,
  note: '改了配色',
  prototype: { code: 'crm-p01', id: PROTOTYPE_ID, project: { code: 'crm', id: PROJECT_ID } },
  prototypeId: PROTOTYPE_ID,
  retryCount: 0,
  sourceName: 'demo.zip',
  sourceSize: 2048n,
  tempKey: 'tmp/upload-128-abcd1234.zip',
};

const STATUS_ENTITY: StatusEntity = {
  errorCode: null,
  errorMessage: null,
  id: TASK_ID,
  progress: 100,
  prototype: { code: 'crm-p01', id: PROTOTYPE_ID, project: { code: 'crm', id: PROJECT_ID } },
  prototypeId: PROTOTYPE_ID,
  releaseId: RELEASE_ID,
  sourceName: 'demo.zip',
  sourceSize: 2048n,
  stage: 'committing',
  status: 'success',
  warnings: [
    { code: UNWRAP.code, message: UNWRAP.message },
    { code: REWRITE.code, count: 12, message: REWRITE.message },
  ],
};

/** 交出去的那份任务：库里 bigint 的体积在这一层转成 number，两段编码摊平。 */
const CLAIMED_TASK: ClaimedTask = {
  createdBy: 4n,
  id: TASK_ID,
  note: '改了配色',
  ownership: OWNERSHIP,
  projectCode: 'crm',
  projectId: PROJECT_ID,
  prototypeCode: 'crm-p01',
  prototypeId: PROTOTYPE_ID,
  retryCount: 0,
  sourceName: 'demo.zip',
  sourceSize: 2048,
  tempKey: 'tmp/upload-128-abcd1234.zip',
};

const SUCCESS_PATCH: SuccessPatch = {
  releaseId: RELEASE_ID,
  stage: 'committing',
  warnings: [UNWRAP, REWRITE],
};

const FAILURE_PATCH: FailurePatch = {
  errorCode: ERROR_CODES.UPLOAD_UNSAFE_PATH,
  errorMessage: '压缩包内含非法路径（绝对路径或 ..）：条目 "../a"',
  stage: 'extracting',
  warnings: [UNWRAP],
};

interface RawCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface ClaimUpdateArgs {
  readonly data: { progress: number; stage: string; startedAt: Date; status: string };
  readonly include: unknown;
  readonly where: unknown;
}

interface UpdateManyArgs {
  readonly data: Record<string, unknown>;
  readonly where: Record<string, unknown>;
}

interface FindFirstArgs {
  readonly select: Record<string, unknown>;
  readonly where: Record<string, unknown>;
}

interface HarnessOptions {
  /** `FOR UPDATE SKIP LOCKED` 选中的候选行：`[]` = 没任务，或唯一候选正被别的实例锁着。 */
  readonly claimRows?: Array<{ id: bigint }>;
  /** 候选行 join 回来的整行：用来造"没带 temp_key 的历史行"这类边界数据。 */
  readonly claimEntity?: ClaimEntity;
  /** `updateMany` 的命中行数：0 = 这一行已经不是 processing 了。 */
  readonly updatedCount?: number;
  /** `findFirst` 的返回行；默认 `null` = 库里没这条任务。 */
  readonly statusRow?: StatusEntity | null;
  /** 巡检两条 UPDATE 各自的行数，按调用顺序。 */
  readonly staleCounts?: readonly [number, number];
}

interface Harness {
  readonly claimUpdates: ClaimUpdateArgs[];
  readonly executeRaw: RawCall[];
  readonly findFirstArgs: FindFirstArgs[];
  /** 动作流水；事务之外发生的调用会被标出来（`名字(事务外)`）。 */
  readonly ops: string[];
  readonly queryRaw: RawCall[];
  readonly repo: UploadTaskRepo;
  readonly transactions: () => number;
  readonly updateManyCalls: UpdateManyArgs[];
}

function harness(options: HarnessOptions = {}): Harness {
  const claimUpdates: ClaimUpdateArgs[] = [];
  const executeRaw: RawCall[] = [];
  const findFirstArgs: FindFirstArgs[] = [];
  const ops: string[] = [];
  const queryRaw: RawCall[] = [];
  const updateManyCalls: UpdateManyArgs[] = [];
  let insideTransaction = false;
  let transactionCount = 0;
  let staleCallIndex = 0;

  const record = (name: string): void => {
    ops.push(insideTransaction ? name : `${name}(事务外)`);
  };

  const client = {
    protoUploadTask: {
      findFirst: vi.fn(async (args: FindFirstArgs): Promise<StatusEntity | null> => {
        findFirstArgs.push(args);
        record('读任务状态');
        return options.statusRow ?? null;
      }),
      update: vi.fn(async (args: ClaimUpdateArgs): Promise<ClaimEntity> => {
        claimUpdates.push(args);
        record('占任务');
        return options.claimEntity ?? CLAIM_ENTITY;
      }),
      updateMany: vi.fn(async (args: UpdateManyArgs): Promise<{ count: number }> => {
        updateManyCalls.push(args);
        record('回填任务行');
        return { count: options.updatedCount ?? 1 };
      }),
    },
    // 真 Prisma 的裸 SQL 是标签模板：第一个实参是字面量数组，插值按位置进来（join('?') 还原成带占位符的 SQL）。
    $executeRaw: vi.fn(async (
      strings: readonly string[],
      ...values: unknown[]
    ): Promise<number> => {
      executeRaw.push({ sql: strings.join('?'), values });
      record('巡检 UPDATE');
      return options.staleCounts?.[staleCallIndex++] ?? 0;
    }),
    $queryRaw: vi.fn(async (
      strings: readonly string[],
      ...values: unknown[]
    ): Promise<unknown> => {
      queryRaw.push({ sql: strings.join('?'), values });
      record('取候选');
      return options.claimRows ?? [{ id: TASK_ID }];
    }),
  };

  const db = {
    ...client,
    $transaction: vi.fn(async (
      work: (tx: typeof client) => Promise<ClaimEntity>,
    ): Promise<ClaimEntity> => {
      transactionCount += 1;
      insideTransaction = true;
      try {
        return await work(client);
      } finally {
        insideTransaction = false;
      }
    }),
  };

  return {
    claimUpdates,
    executeRaw,
    findFirstArgs,
    ops,
    queryRaw,
    repo: new UploadTaskRepo(db as unknown as PrismaClient),
    transactions: () => transactionCount,
    updateManyCalls,
  };
}

/** 取一条 SQL 文本并把换行压平：断言整句而不是关键字，改一个字节都要在这里显形。 */
function flat(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function firstQuery(h: Harness): RawCall {
  const call = h.queryRaw[0];
  if (call === undefined) {
    throw new Error('没有取候选的语句');
  }
  return call;
}

function staleCall(h: Harness, nth: number): RawCall {
  const call = h.executeRaw[nth];
  if (call === undefined) {
    throw new Error(`只有 ${String(h.executeRaw.length)} 条巡检 UPDATE`);
  }
  return call;
}

function claimUpdate(h: Harness): ClaimUpdateArgs {
  const call = h.claimUpdates[0];
  if (call === undefined) {
    throw new Error('没有占任务那次 update');
  }
  return call;
}

function lastWrite(h: Harness): UpdateManyArgs {
  const call = h.updateManyCalls.at(-1);
  if (call === undefined) {
    throw new Error('没有任何任务行写入');
  }
  return call;
}

/** 时钟冻住：`started_at`/`finished_at` 落的是哪一刻才可断言（文件本身没有可注入的 clock）。 */
function frozenClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FROZEN_AT);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('不变量 1：claim 取到即占（§3.3）', () => {
  it('选中与置 processing 在同一个事务回调里：锁随事务释放，别个实例此刻只会看见 processing', async () => {
    const h = harness();

    await h.repo.claim('extracting');

    expect(h.transactions()).toBe(1);
    expect(h.ops).toEqual(['取候选', '占任务']);
  });

  it('候选查询就是那一句：只认 pending、按 created_at 排队（并列时按 id）、一次一条、抢占式锁', async () => {
    const h = harness();

    await h.repo.claim('extracting');

    // 整句逐字比对：排队顺序（created_at, id）与抢占式锁（SKIP LOCKED）都在这一句里，改一个字节都要显形。
    // 并列值必须有个次键：Postgres 不保证并列行的先后，缺了 id 时同一毫秒提交的两条谁先跑会随执行计划变。
    expect(flat(firstQuery(h).sql)).toBe(CLAIM_SELECT_SQL);
    // 这一句不插任何外部值：pending 与 limit 1 都是字面量，没有可被拼接的入口。
    expect(firstQuery(h).values).toEqual([]);
  });

  it('占任务那次写：status=processing、stage 落在开工阶段、progress 取 §2.1 的区间下界', async () => {
    const h = harness();

    await h.repo.claim('extracting');

    expect(claimUpdate(h).data).toEqual({
      progress: stageStartProgress('extracting'),
      stage: 'extracting',
      startedAt: expect.any(Date),
      status: 'processing',
    });
    // 下界而不是 0：取到任务的那一刻进度就该跳到 extracting 的起点（§2.1）。
    expect(claimUpdate(h).data.progress).toBe(10);
    // 归属由事务里那条 FOR UPDATE 保证，所以这里不需要再带 status 条件（与回填是两种机制）。
    expect(claimUpdate(h).where).toEqual({ id: TASK_ID });
  });

  it('started_at 就是取到的那一刻：§3.2 的超时判据从这一步起算', async () => {
    frozenClock();
    const h = harness();

    await h.repo.claim('postprocess');

    expect(claimUpdate(h).data.startedAt.toISOString()).toBe(FROZEN_AT.toISOString());
    expect(claimUpdate(h).data.stage).toBe('postprocess');
    expect(claimUpdate(h).data.progress).toBe(stageStartProgress('postprocess'));
  });

  it('join 只取两段编码与项目 id：§5.3 响应体与 §2.6 改写前缀的原料', async () => {
    const h = harness();

    await h.repo.claim('extracting');

    expect(claimUpdate(h).include).toEqual({
      prototype: { include: { project: { select: { code: true, id: true } } } },
    });
  });

  it('交出去的形状：编码摊平、落库 bigint 的体积转成 number，流水线不用到处 BigInt 运算', async () => {
    frozenClock();
    const h = harness();

    await expect(h.repo.claim('extracting')).resolves.toEqual(CLAIMED_TASK);
    // 令牌就是这次写进库的那个时刻：回填比对的是同一个值，不存在"写了 A 却拿 B 去比"。
    expect(claimUpdate(h).data.startedAt).toEqual(CLAIMED_TASK.ownership.startedAt);
  });

  it('唯一候选正被别的实例锁着（SKIP LOCKED 返回空）→ 安静地 null，一行都不写', async () => {
    const h = harness({ claimRows: [] });

    await expect(h.repo.claim('extracting')).resolves.toBeNull();
    expect(h.transactions()).toBe(1);
    expect(h.claimUpdates).toHaveLength(0);
    expect(h.updateManyCalls).toHaveLength(0);
  });

  it('没带 temp_key/note 的历史行如实交出 null，retry_count 原样交出去', async () => {
    frozenClock();
    const h = harness({
      claimEntity: { ...CLAIM_ENTITY, note: null, retryCount: 1, tempKey: null },
    });

    await expect(h.repo.claim('extracting')).resolves.toEqual({
      ...CLAIMED_TASK,
      note: null,
      retryCount: 1,
      tempKey: null,
    });
  });
});

describe('不变量 2：回填与终态只认"自己那一次领取"', () => {
  it('patchProgress 只写 progress/stage 两列，where 带 status=processing + 本次 started_at，且不开事务', async () => {
    const h = harness();

    const kept = await h.repo.patchProgress(OWNERSHIP, 'extracting', 45);

    expect(kept).toBe(true);
    expect(h.updateManyCalls).toEqual([
      {
        data: { progress: 45, stage: 'extracting' },
        where: { id: TASK_ID, startedAt: FROZEN_AT, status: 'processing' },
      },
    ]);
    expect(h.transactions()).toBe(0);
  });

  it('写到自己那一行才报 true；被巡检捞走（count=0）报 false，Worker 据此停手', async () => {
    const lost = harness({ updatedCount: 0 });

    await expect(lost.repo.patchProgress(OWNERSHIP, 'postprocess', 60)).resolves.toBe(false);
    expect(lost.transactions()).toBe(0);
  });

  it('成功终态：progress 固定 100、releaseId 指向新版本、错误列清空（§3.1 第 4 步）', async () => {
    frozenClock();
    const h = harness();

    await expect(h.repo.markSuccess(OWNERSHIP, SUCCESS_PATCH)).resolves.toBe(true);

    expect(h.updateManyCalls).toEqual([
      {
        data: {
          errorCode: null,
          errorMessage: null,
          finishedAt: FROZEN_AT,
          progress: 100,
          releaseId: RELEASE_ID,
          stage: 'committing',
          status: 'success',
          warnings: [
            { code: UNWRAP.code, message: UNWRAP.message },
            { code: REWRITE.code, count: 12, message: REWRITE.message },
          ],
        },
        where: { id: TASK_ID, startedAt: FROZEN_AT, status: 'processing' },
      },
    ]);
  });

  it('迟到的成功写入匹配不到接管者的行：盖不掉状态，本层也不改行数列', async () => {
    const h = harness({ updatedCount: 0 });

    await expect(h.repo.markSuccess(OWNERSHIP, SUCCESS_PATCH)).resolves.toBe(false);
    await expect(h.repo.markFailure(OWNERSHIP, FAILURE_PATCH)).resolves.toBe(false);

    expect(lastWrite(h).where).toEqual({
      id: TASK_ID,
      startedAt: FROZEN_AT,
      status: 'processing',
    });
  });

  it('接管者的 started_at 与旧令牌不同：同一行换了归属，旧令牌的 where 就不再命中它', async () => {
    const h = harness();

    // 重投把 started_at 清成 null，接管者再写入新时刻——旧令牌的三条件里至少这一条对不上。
    await h.repo.patchProgress(
      { startedAt: new Date(FROZEN_AT.getTime() + 60_000), taskId: TASK_ID },
      'extracting',
      20,
    );

    expect(lastWrite(h).where).toEqual({
      id: TASK_ID,
      startedAt: new Date(FROZEN_AT.getTime() + 60_000),
      status: 'processing',
    });
  });

  it('失败终态：错误码 + 那句"下一步做什么"的话 + 阶段一起落，界面直接读（§8.2）', async () => {
    frozenClock();
    const h = harness();

    await h.repo.markFailure(OWNERSHIP, FAILURE_PATCH);

    expect(h.updateManyCalls).toEqual([
      {
        data: {
          errorCode: ERROR_CODES.UPLOAD_UNSAFE_PATH,
          errorMessage: '压缩包内含非法路径（绝对路径或 ..）：条目 "../a"',
          finishedAt: FROZEN_AT,
          stage: 'extracting',
          status: 'failed',
          warnings: [{ code: UNWRAP.code, message: UNWRAP.message }],
        },
        where: { id: TASK_ID, startedAt: FROZEN_AT, status: 'processing' },
      },
    ]);
  });

  it('error_message 是 varchar(500)：超长文案截到 500 而不是让整条写库失败', async () => {
    const h = harness();

    await h.repo.markFailure(OWNERSHIP, { ...FAILURE_PATCH, errorMessage: 'x'.repeat(600) });

    const written = lastWrite(h).data['errorMessage'];
    expect(typeof written).toBe('string');
    expect(written).toHaveLength(500);
    expect(written).toBe('x'.repeat(500));
  });

  it('还没有阶段可报时如实写 null：§2.1 的阶段区间不该被猜成一个阶段', async () => {
    const h = harness();

    await h.repo.markFailure(OWNERSHIP, { ...FAILURE_PATCH, stage: null });

    expect(lastWrite(h).data['stage']).toBeNull();
  });

  it('失败不动 progress、也不动 retry_count：停在失败那一刻才有诊断价值，重投上界归巡检', async () => {
    const h = harness();

    await h.repo.markFailure(OWNERSHIP, FAILURE_PATCH);

    const { data } = lastWrite(h);
    expect(Object.hasOwn(data, 'progress')).toBe(false);
    expect(Object.hasOwn(data, 'retryCount')).toBe(false);
    // 已经算出来的发布报告不能因为失败就丢掉。
    expect(data['warnings']).toEqual([{ code: UNWRAP.code, message: UNWRAP.message }]);
  });
});

describe('不变量 3 + §3.2：超时巡检 reclaimStale', () => {
  it('两条 UPDATE 的分支按 retry_count 划开：先判掉重投过的那批，再重投剩下的', async () => {
    const olderThan = new Date('2026-10-06T09:50:00.000Z');
    const h = harness({ staleCounts: [1, 2] });

    await expect(h.repo.reclaimStale(olderThan, 1)).resolves.toEqual({ failed: 1, requeued: 2 });

    expect(h.executeRaw).toHaveLength(2);
    expect(flat(staleCall(h, 0).sql)).toBe(STALE_FAILED_SQL);
    expect(flat(staleCall(h, 1).sql)).toBe(STALE_REQUEUED_SQL);
    // 两条用同一个 10 分钟界与同一个重投上界：判据不能一条 SQL 一个说法。
    expect(staleCall(h, 0).values).toEqual([olderThan, 1]);
    expect(staleCall(h, 1).values).toEqual([olderThan, 1]);
  });

  it('判据是 `started_at < 界` 且 `status = processing`：还在跑与没超时的都不受影响', async () => {
    const h = harness();

    await h.repo.reclaimStale(new Date('2026-10-06T09:50:00.000Z'), 1);

    for (const call of h.executeRaw) {
      expect(flat(call.sql)).toContain("where status = 'processing' and started_at < ?");
    }
  });

  it('判失败那条留的是 §8 的兜底码与那句"请重新发布"：界面按 §8.2 直接读这一行', async () => {
    const h = harness();

    await h.repo.reclaimStale(new Date('2026-10-06T09:50:00.000Z'), 1);

    expect(flat(staleCall(h, 0).sql)).toContain("error_code = 'UPLOAD_WORKER_FAILED'");
    expect(flat(staleCall(h, 0).sql)).toContain(
      "error_message = '处理超时，已自动重试一次仍未完成；请重新发布，或把 traceId 提供给运维'",
    );
    expect(flat(staleCall(h, 0).sql)).toContain('finished_at = now()');
  });

  it('重投那条把 progress/stage/started_at 一起清掉并 +1：用户看到的是重新排队，不是停在 37% 的僵尸', async () => {
    const h = harness();

    await h.repo.reclaimStale(new Date('2026-10-06T09:50:00.000Z'), 1);

    const requeued = flat(staleCall(h, 1).sql);
    expect(requeued).toContain("set status = 'pending', started_at = null, stage = null, progress = 0");
    expect(requeued).toContain('retry_count = retry_count + 1');
    // 留下的 `tmp/work-{taskId}/` 归 GC（§4.3）：这一层不做任何目录操作，也没有别的库动作。
    expect(h.ops).toEqual(['巡检 UPDATE(事务外)', '巡检 UPDATE(事务外)']);
    expect(h.transactions()).toBe(0);
    expect(h.queryRaw).toHaveLength(0);
    expect(h.updateManyCalls).toHaveLength(0);
  });

  it('空转（没有卡死任务）如实报 0/0，不编出"救回了任务"的结论', async () => {
    const h = harness({ staleCounts: [0, 0] });

    await expect(h.repo.reclaimStale(new Date(), 1)).resolves.toEqual({ failed: 0, requeued: 0 });
  });
});

describe('§5.3 的任务状态读', () => {
  it('select 只要任务行自己的列 + 两段编码的来路：本层不查 proto_release（§3.3 的分工）', async () => {
    const h = harness();

    await h.repo.findForStatus(TASK_ID);

    expect(h.findFirstArgs).toEqual([
      {
        select: {
          errorCode: true,
          errorMessage: true,
          id: true,
          progress: true,
          prototype: {
            select: {
              code: true,
              id: true,
              project: { select: { code: true, id: true } },
            },
          },
          prototypeId: true,
          releaseId: true,
          sourceName: true,
          sourceSize: true,
          stage: true,
          status: true,
          warnings: true,
        },
        where: { id: TASK_ID },
      },
    ]);
    expect(h.queryRaw).toHaveLength(0);
  });

  it('查不到就 null：任务不存在/已被回收由服务层判 404，本层不猜', async () => {
    const h = harness({ statusRow: null });

    await expect(h.repo.findForStatus(TASK_ID)).resolves.toBeNull();
  });

  it('成功行的形状：编码摊平、bigint 体积转 number、warnings 走同一份 codec', async () => {
    const h = harness({ statusRow: STATUS_ENTITY });

    await expect(h.repo.findForStatus(TASK_ID)).resolves.toEqual({
      errorCode: null,
      errorMessage: null,
      id: TASK_ID,
      progress: 100,
      projectCode: 'crm',
      projectId: PROJECT_ID,
      prototypeCode: 'crm-p01',
      prototypeId: PROTOTYPE_ID,
      releaseId: RELEASE_ID,
      sourceName: 'demo.zip',
      sourceSize: 2048,
      stage: 'committing',
      status: 'success',
      warnings: [UNWRAP, REWRITE],
    });
  });

  it('库里越界的 status/stage 按最保守取值收敛：未知状态当已结束，否则前端一直轮下去', async () => {
    const h = harness({
      statusRow: { ...STATUS_ENTITY, stage: 'Extracting', status: 'Processing' },
    });

    const row = await h.repo.findForStatus(TASK_ID);

    expect(row?.status).toBe('failed');
    expect(row?.stage).toBeNull();
  });

  it('canceled 是 §4.2.6 的合法取值：不能被当成越界值改写成 failed', async () => {
    const h = harness({ statusRow: { ...STATUS_ENTITY, status: 'canceled' } });

    expect((await h.repo.findForStatus(TASK_ID))?.status).toBe('canceled');
  });

  it('error_code 空就是空，越界才兜到 UPLOAD_WORKER_FAILED', async () => {
    const empty = harness({ statusRow: STATUS_ENTITY });
    expect((await empty.repo.findForStatus(TASK_ID))?.errorCode).toBeNull();

    const bogus = harness({ statusRow: { ...STATUS_ENTITY, errorCode: 'UPLOAD_FAILED' } });
    expect((await bogus.repo.findForStatus(TASK_ID))?.errorCode).toBe(
      ERROR_CODES.UPLOAD_WORKER_FAILED,
    );
  });

  it('PROTO_NOT_FOUND 只在任务状态里出现（机制 §3.2），读侧必须认它', async () => {
    const h = harness({
      statusRow: { ...STATUS_ENTITY, errorCode: ERROR_CODES.PROTO_NOT_FOUND },
    });

    const row = await h.repo.findForStatus(TASK_ID);

    expect(row?.errorCode).toBe(ERROR_CODES.PROTO_NOT_FOUND);
    expect(row?.errorMessage).toBeNull();
  });

  it('warnings 里一条坏数据只丢自己：§5.3 不该因为 jsonb 被改坏而整条打不开', async () => {
    const h = harness({
      statusRow: {
        ...STATUS_ENTITY,
        warnings: [
          { code: 'NOT_A_WARNING_CODE', message: '人工写进去的' },
          { code: UNWRAP.code, message: UNWRAP.message },
        ],
      },
    });

    expect((await h.repo.findForStatus(TASK_ID))?.warnings).toEqual([UNWRAP]);
  });

  it('读一条任务不发任何写：§5.3 每秒轮一次，轮询本身不许改队列', async () => {
    const h = harness({ statusRow: STATUS_ENTITY });

    await h.repo.findForStatus(TASK_ID);

    expect(h.updateManyCalls).toHaveLength(0);
    expect(h.claimUpdates).toHaveLength(0);
    expect(h.executeRaw).toHaveLength(0);
    expect(h.transactions()).toBe(0);
  });
});

describe('阶段参数是透传的（§2.1 的区间表只有一处定义）', () => {
  const stages: readonly UploadTaskStage[] = ['validating', 'extracting', 'postprocess', 'committing'];

  it.each(stages)('claim(%s) 把 stage 与它的区间下界一起写进去', async (stage) => {
    const h = harness();

    await h.repo.claim(stage);

    expect(claimUpdate(h).data).toEqual({
      progress: stageStartProgress(stage),
      stage,
      startedAt: expect.any(Date),
      status: 'processing',
    });
  });
});

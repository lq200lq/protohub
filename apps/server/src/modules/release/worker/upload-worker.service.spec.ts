import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, UPLOAD_WARNING_CODES } from '@protohub/shared';

import {
  UPLOAD_TASK_MAX_RETRY,
  UPLOAD_TASK_STALE_MS,
  UPLOAD_WORKER_POLL_MS,
  UPLOAD_WORKER_SWEEP_MS,
} from '../../../config/constants';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import { buildZip, type ZipEntryFixture } from '../../../testing/zip.fixture';
import { LocalStorageAdapter } from '../../storage/local-storage.adapter';
import { requireLocalPath } from '../../storage/storage.adapter';
import { workDirKey } from '../../storage/storage-keys';
import {
  PrototypeDeletedError,
  type CommitInput,
  type CommitResult,
} from '../pipeline/commit';
import type { ClaimedTask, ClaimOwnership, FailurePatch } from './upload-task.repo';
import { UploadWorkerService } from './upload-worker.service';

/**
 * Worker 单测（机制 §3.3 + §3.2 + §2.1，计划 M3-T4）。
 *
 * 这里钉的是**只有这一层负责**的四件事；四件判定本身（校验、入口、改写、版本写入顺序）已分别在
 * validate / extract / postprocess / commit 的单测里钉过，不在这儿重测：
 * 1. **接线是真的流水线**：真磁盘 + 真 `extractZipToWorkDir` + 真 `postprocessWorkDir`，
 *    所以"产物被按 `/p/{项目码}/{原型码}` 改写过了""警告从清单原样进了任务行"都是量出来的而不是猜的。
 * 2. **进度回填的口径**：阶段顺序按 §2.1 的区间表只前进、`(stage, progress)` 同值不重复写库。
 * 3. **任务归属**：每次回填都带上这次领取的归属令牌；`patchProgress()` 返回 false 时立刻停手——
 *    不写终态，也**不删**接管者正在用的工作目录。终态写落空（提交期间归属被换走）时如实记一句
 *    warn，不谎报"发布完成"。
 * 4. **失败分诊**：§8 的码、§3.2 点名的 `PROTO_NOT_FOUND`、以及"原始包留住、工作目录当场回收"。
 *
 * `UploadTaskRepo` 用桩：`FOR UPDATE SKIP LOCKED` 与超时重投的 SQL 行为要到库里才验得（M3-T16 集成测试）。
 */

const TASK_ID = 128n;
const TEMP_KEY = 'tmp/upload-128-abcd1234.zip';
/** 这一次领取的归属令牌：桩掉的 repo 靠它判断"写的是不是自己那一行"。 */
const STARTED_AT = new Date('2026-10-06T10:00:00.000Z');
const OWNERSHIP: ClaimOwnership = { startedAt: STARTED_AT, taskId: TASK_ID };
const COMMIT_RESULT: CommitResult = {
  releaseId: 77n,
  storageKey: 'releases/9/31/77',
  versionNo: 4,
};

const DEMO_ENTRIES: ZipEntryFixture[] = [
  {
    name: 'index.html',
    data: '<!doctype html><html><body><img src="/assets/logo.png" alt="logo"></body></html>',
  },
  { name: 'assets/logo.png', data: 'fake-png-bytes' },
];

function taskOf(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  const id = overrides.id ?? TASK_ID;
  return {
    createdBy: 4n,
    id,
    note: '改了配色',
    // 令牌跟着 id 走：并发上限那条用例会造第二任务（129n），照抄 128n 就把形状写错了。
    ownership: { startedAt: STARTED_AT, taskId: id },
    projectCode: 'crm',
    projectId: 9n,
    prototypeCode: 'crm-p01',
    prototypeId: 31n,
    retryCount: 0,
    sourceName: 'demo.zip',
    sourceSize: 0,
    tempKey: TEMP_KEY,
    ...overrides,
  };
}

interface HarnessOptions {
  /** 让每次进度写都等一个闸门：用来把"任务还在处理中"这段时间按住。 */
  readonly hangProgress?: boolean;
  /** 第 N 次进度写之后返回 false（模拟任务已被 §3.2 的巡检捞走）。 */
  readonly lostFrom?: number;
  /** 终态写入一律报"没写到"：模拟提交期间归属被换走（版本已落地，任务行不归我了）。 */
  readonly loseTerminalWrite?: boolean;
  readonly commitError?: Error;
  readonly entries?: ZipEntryFixture[];
  readonly envOverrides?: Record<string, unknown>;
  readonly task?: Partial<ClaimedTask>;
}

interface Harness {
  readonly claim: ReturnType<typeof vi.fn>;
  readonly commit: ReturnType<typeof vi.fn>;
  readonly markFailure: ReturnType<typeof vi.fn>;
  readonly markSuccess: ReturnType<typeof vi.fn>;
  readonly patchProgress: ReturnType<typeof vi.fn>;
  readonly reclaimStale: ReturnType<typeof vi.fn>;
  readonly releaseProgress: () => void;
  readonly service: UploadWorkerService;
  readonly workDir: string;
  readonly zipPath: string;
}

const tempDirs: string[] = [];

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-worker-'));
  tempDirs.push(root);
  const env = fakeAppEnv({ STORAGE_ROOT: root, ...options.envOverrides });
  const storage = new LocalStorageAdapter(env);
  // 建出 §1.2 的目录布局（tmp/ 在这里，写假包才有地方）。
  await storage.onModuleInit();

  const zipBytes = buildZip(options.entries ?? DEMO_ENTRIES);
  const zipPath = requireLocalPath(storage, TEMP_KEY);
  await writeFile(zipPath, zipBytes);
  const task = taskOf({ sourceSize: zipBytes.length, ...options.task });

  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const patchProgress = vi.fn(async (): Promise<boolean> => {
    writes += 1;
    if (options.hangProgress === true) {
      await gate;
    }
    return options.lostFrom === undefined || writes <= options.lostFrom;
  });
  const claim = vi.fn(async (): Promise<ClaimedTask | null> => task);
  const commit = vi.fn(async (): Promise<CommitResult> => {
    if (options.commitError !== undefined) {
      throw options.commitError;
    }
    return COMMIT_RESULT;
  });
  const markFailure = vi.fn(
    async (): Promise<boolean> => options.loseTerminalWrite !== true,
  );
  const markSuccess = vi.fn(
    async (): Promise<boolean> => options.loseTerminalWrite !== true,
  );
  const reclaimStale = vi.fn(async () => ({ failed: 0, requeued: 0 }));
  const service = new UploadWorkerService(
    { claim, markFailure, markSuccess, patchProgress, reclaimStale } as never,
    { commit } as never,
    env,
    storage,
  );

  return {
    claim,
    commit,
    markFailure,
    markSuccess,
    patchProgress,
    reclaimStale,
    releaseProgress: () => release(),
    service,
    workDir: requireLocalPath(storage, workDirKey(String(TASK_ID))),
    zipPath,
  };
}

interface LogSink {
  readonly error: unknown[][];
  readonly log: unknown[][];
  readonly warn: unknown[][];
}

/** 把服务实例的 Nest logger 换成数组：日志断言不依赖 pino 的 stdout。 */
function captureLogs(service: UploadWorkerService): LogSink {
  const sink: LogSink = { error: [], log: [], warn: [] };
  Object.defineProperty(service, 'logger', {
    configurable: true,
    value: {
      error: (...args: unknown[]): undefined => {
        sink.error.push(args);
        return undefined;
      },
      log: (...args: unknown[]): undefined => {
        sink.log.push(args);
        return undefined;
      },
      warn: (...args: unknown[]): undefined => {
        sink.warn.push(args);
        return undefined;
      },
    },
    writable: true,
  });
  return sink;
}

/**
 * 任务行收到的那份失败补丁。
 *
 * vitest 4 的 `mock.lastCall` 直接就是实参数组（旧版那种 `.lastCall.args` 在这里是 undefined），
 * 所以取位写死在这一处：这些用例里失败只写一次，先钉次数再取第二个实参。
 */
function failurePatchOf(markFailure: ReturnType<typeof vi.fn>): FailurePatch {
  expect(markFailure).toHaveBeenCalledTimes(1);
  const [, patch] = markFailure.mock.lastCall as [ClaimOwnership, FailurePatch];
  return patch;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { force: true, recursive: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('流水线接线（§2.1 ②③④ + §3.3）', () => {
  it('一条任务跑完全程，且改写前缀来自任务自带的那两段编码', async () => {
    const h = await harness();

    await expect(h.service.tick()).resolves.toBe(true);

    expect(h.claim).toHaveBeenCalledWith('extracting');
    expect(h.commit).toHaveBeenCalledTimes(1);
    const [input] = h.commit.mock.lastCall as [CommitInput];
    expect(input).toMatchObject({
      createdBy: 4n,
      note: '改了配色',
      projectId: 9n,
      prototypeId: 31n,
      workDir: h.workDir,
    });
    // §2.7 的 source_hash 打在原始包字节上（下次发布去重要用它），值必须与包内容一致。
    const expectedHash = createHash('sha256').update(await readFile(h.zipPath)).digest('hex');
    expect(input.sourceHash).toBe(expectedHash);
    // 真跑过流水线的证据：清单里有改写警告，磁盘上的产物真的带上了访问前缀。
    expect(input.manifest.warnings.map((warning) => warning.code)).toContain(
      UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH,
    );
    const html = await readFile(join(h.workDir, input.entry), 'utf8');
    expect(html).toContain('/p/crm/crm-p01/assets/logo.png');
    expect(html).not.toContain('src="/assets/logo.png"');
    expect(h.markSuccess).toHaveBeenCalledWith(OWNERSHIP, {
      releaseId: 77n,
      stage: 'committing',
      warnings: input.manifest.warnings,
    });
  });

  it('进度按 §2.1 的区间回填：阶段只前进，同值不重复写库', async () => {
    const h = await harness();

    await h.service.tick();

    // patchProgress(ownership, stage, progress)：参数位序读错就会把归属令牌当成阶段，所以取位写死在这里。
    const writes = h.patchProgress.mock.calls.map((call) => ({
      progress: call[2] as number,
      stage: call[1] as string,
    }));
    // 每一次回填都带上这次领取的令牌（不变量 2 的调用侧半边）：漏一次就等于给僵尸留了写入的口子。
    expect(new Set(h.patchProgress.mock.calls.map((call) => call[0]))).toEqual(new Set([OWNERSHIP]));
    expect(writes.length).toBeGreaterThan(0);
    const keys = writes.map((write) => `${write.stage}:${String(write.progress)}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(writes.map((write) => write.progress)).toEqual(
      [...writes.map((write) => write.progress)].sort((a, b) => a - b),
    );
    expect(writes[0]?.stage).toBe('extracting');
    expect(writes.at(-1)).toEqual({ progress: 90, stage: 'committing' });
    expect(writes.some((write) => write.stage === 'postprocess')).toBe(true);
  });

  it('没有任务时什么都不做', async () => {
    const h = await harness();
    h.claim.mockResolvedValue(null);

    await expect(h.service.tick()).resolves.toBe(false);
    expect(h.patchProgress).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('串行消费：处理中的任务没落地前不再取第二条', async () => {
    const h = await harness({ hangProgress: true });

    const first = h.service.tick();
    await vi.waitFor(() => expect(h.patchProgress).toHaveBeenCalled());

    await expect(h.service.tick()).resolves.toBe(false);
    expect(h.claim).toHaveBeenCalledTimes(1);

    h.releaseProgress();
    await first;
    expect(h.markSuccess).toHaveBeenCalledTimes(1);
  });

  it('并发上限读 env：MAX_CONCURRENT_TASKS=2 时两条可以同时处理', async () => {
    const h = await harness({
      envOverrides: { MAX_CONCURRENT_TASKS: 2 },
      hangProgress: true,
    });
    h.claim
      .mockResolvedValueOnce(taskOf())
      .mockResolvedValueOnce(taskOf({ id: 129n }));

    const first = h.service.tick();
    const second = h.service.tick();
    await vi.waitFor(() => expect(h.claim).toHaveBeenCalledTimes(2));

    h.releaseProgress();
    await Promise.all([first, second]);
    expect(h.markSuccess).toHaveBeenCalledTimes(2);
  });
});

describe('失败分诊（§8 + §3.2）', () => {
  it('处理趟重做轻校验：没有 index.html 的包在解压前就失败，工作目录根本没建、原始包留住', async () => {
    const h = await harness({ entries: [{ data: '<html></html>', name: 'page.html' }] });

    await expect(h.service.tick()).resolves.toBe(true);

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.UPLOAD_MISSING_ENTRY);
    expect(patch.stage).toBe('extracting');
    expect(h.commit).not.toHaveBeenCalled();
    expect(existsSync(h.workDir)).toBe(false);
    expect(existsSync(h.zipPath)).toBe(true);
  });

  it('非法路径条目按 `UPLOAD_UNSAFE_PATH` 失败，并把是哪个条目说清楚', async () => {
    const h = await harness({
      entries: [
        { data: '<html></html>', name: 'index.html' },
        { data: 'evil', name: '../escape.html' },
      ],
    });

    await h.service.tick();

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.UPLOAD_UNSAFE_PATH);
    expect(patch.errorMessage).toContain('escape.html');
    expect(existsSync(h.zipPath)).toBe(true);
  });

  it('提交阶段磁盘写满：按 §8 的 `UPLOAD_DISK_FULL` 落库，工作目录当场回收', async () => {
    const h = await harness({
      commitError: Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
    });

    await h.service.tick();

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.UPLOAD_DISK_FULL);
    // 用的是 §8 那句人话，而不是驱动的错误文案。
    expect(patch.errorMessage).toBe('存储空间不足');
    expect(patch.stage).toBe('committing');
    // 已经算出来的发布报告不能因为失败就丢掉：界面要能解释它走到了哪一步。
    expect(patch.warnings.length).toBeGreaterThan(0);
    expect(existsSync(h.workDir)).toBe(false);
    expect(existsSync(h.zipPath)).toBe(true);
  });

  it('发布过程中原型被删：失败码是 §3.2 点名的 PROTO_NOT_FOUND，而不是"请重试"', async () => {
    const h = await harness({ commitError: new PrototypeDeletedError(31n) });

    await h.service.tick();

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.PROTO_NOT_FOUND);
    expect(patch.errorMessage).toContain('已被删除');
    // 这一条与其余失败的形状不同：§3.2 原文要求"并清理 tmp"，重投只会撞同一堵墙，包留着没意义。
    expect(existsSync(h.zipPath)).toBe(false);
  });

  it('任务行没有 temp_key 时不猜路径，如实报处理异常', async () => {
    const h = await harness({ task: { tempKey: null } });

    await h.service.tick();

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.UPLOAD_WORKER_FAILED);
    expect(patch.errorMessage).toBe('任务没有可用的临时文件，请重新发布');
    expect(patch.stage).toBe('extracting');
    expect(existsSync(h.workDir)).toBe(false);
  });

  it('意外异常不把原始文案给用户，换成 §8 的兜底话术', async () => {
    const h = await harness({ commitError: new TypeError('cannot read properties of null') });

    await h.service.tick();

    const patch = failurePatchOf(h.markFailure);
    expect(patch.errorCode).toBe(ERROR_CODES.UPLOAD_WORKER_FAILED);
    expect(patch.errorMessage).toBe('处理过程中出现异常，请重试');
  });
});

describe('任务归属（§3.2 的巡检接管）', () => {
  it('进度写发现任务已被捞走：停止写库，也不删接管者正在用的工作目录', async () => {
    const h = await harness({ lostFrom: 0 });

    await expect(h.service.tick()).resolves.toBe(true);

    expect(h.patchProgress).toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.markSuccess).not.toHaveBeenCalled();
    expect(h.markFailure).not.toHaveBeenCalled();
    expect(existsSync(h.workDir)).toBe(true);
  });

  it('提交期间归属被换走：终态写落空就如实记 warn，不说成"这次发布完成"', async () => {
    const h = await harness({ loseTerminalWrite: true });
    const sink = captureLogs(h.service);

    await expect(h.service.tick()).resolves.toBe(true);

    expect(h.markSuccess).toHaveBeenCalledWith(OWNERSHIP, expect.anything());
    expect(sink.warn.map(([message]) => String(message)).join()).toContain('终态回填落空');
    expect(sink.log.map(([message]) => String(message)).join()).not.toContain('发布完成');
  });

  it('失败判写落空时不再动盘：工作目录与原始包都留给接管者，等 GC 收尾', async () => {
    const h = await harness({
      commitError: new PrototypeDeletedError(31n),
      loseTerminalWrite: true,
    });
    const sink = captureLogs(h.service);

    await h.service.tick();

    expect(h.markFailure).toHaveBeenCalledWith(
      OWNERSHIP,
      expect.objectContaining({ errorCode: ERROR_CODES.PROTO_NOT_FOUND }),
    );
    expect(sink.warn.map(([message]) => String(message)).join()).toContain('不作为终态');
    // 这条失败原本会连原始包一起删（§3.2 点名清理 tmp）：归属已换走时不动它，接管者还在读。
    expect(existsSync(h.workDir)).toBe(true);
    expect(existsSync(h.zipPath)).toBe(true);
  });
});

describe('超时巡检（§3.2「启动时与每 5 分钟」）', () => {
  it('按 10 分钟界与 maxRetry=1 调用重投，并把结论原样返回', async () => {
    const h = await harness();
    h.reclaimStale.mockResolvedValue({ failed: 1, requeued: 2 });
    const before = Date.now();

    const result = await h.service.sweep();

    const [olderThan, maxRetry] = h.reclaimStale.mock.lastCall as [Date, number];
    expect(maxRetry).toBe(UPLOAD_TASK_MAX_RETRY);
    // 界是服务自己取的那次 now，落在 `[before, 现在]` 里，所以两端都以实测值为界
    // （口径与 `release.service.spec.ts` 的幂等窗口断言一致；写成 `<= before - STALE`
    //  会在服务取 now 比 before 晚 1 毫秒时假失败）。
    expect(olderThan.getTime()).toBeGreaterThanOrEqual(before - UPLOAD_TASK_STALE_MS);
    expect(olderThan.getTime()).toBeLessThanOrEqual(Date.now() - UPLOAD_TASK_STALE_MS);
    expect(result).toEqual({ failed: 1, requeued: 2 });
  });

  it('真的捞到任务才记一句日志，空转不刷日志', async () => {
    const idle = await harness();
    const idleSink = captureLogs(idle.service);
    await idle.service.sweep();
    expect(idleSink.log).toHaveLength(0);

    const busy = await harness();
    busy.reclaimStale.mockResolvedValue({ failed: 0, requeued: 3 });
    const busySink = captureLogs(busy.service);
    await busy.service.sweep();
    expect(busySink.log.map(([message]) => String(message)).join()).toContain('重新排队 3 条');
  });
});

describe('定时器（§3.3 的 1 秒轮询）', () => {
  /** 只假定时器与时间，fs/微任务保持真实：`tick()` 里要读盘。 */
  function fakeClock(): void {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  }

  it('开机先巡检一次，之后每 1 秒取任务、每 5 分钟巡检，stop 之后全部安静', async () => {
    fakeClock();
    const h = await harness();
    h.claim.mockResolvedValue(null);

    h.service.start();
    expect(h.reclaimStale).toHaveBeenCalledTimes(1);
    expect(h.claim).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS);
    expect(h.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS * 2);
    expect(h.claim).toHaveBeenCalledTimes(3);

    // 推进 5 分钟会连带打出 300 次轮询（两个定时器共用同一个假时钟），
    // 所以这里只盯巡检自己的次数，轮询的精确次数留给上面那段。
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_SWEEP_MS);
    expect(h.reclaimStale).toHaveBeenCalledTimes(2);

    h.service.stop();
    const claimed = h.claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_SWEEP_MS);
    expect(h.claim).toHaveBeenCalledTimes(claimed);
    expect(h.reclaimStale).toHaveBeenCalledTimes(2);
  });

  it('onApplicationBootstrap 起循环，onModuleDestroy 收掉循环', async () => {
    fakeClock();
    const h = await harness();
    h.claim.mockResolvedValue(null);

    h.service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS);
    expect(h.claim).toHaveBeenCalledTimes(1);

    h.service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS * 2);
    expect(h.claim).toHaveBeenCalledTimes(1);
  });

  it('start 幂等：重复调用不会叠出第二份轮询', async () => {
    fakeClock();
    const h = await harness();
    h.claim.mockResolvedValue(null);

    h.service.start();
    h.service.start();
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS);

    // 两份轮询会把 §3.3 要求的串行变成两路并发，所以第二次 start 必须什么都不做。
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.reclaimStale).toHaveBeenCalledTimes(1);
    h.service.stop();
  });

  it('轮询里的数据库抖动只记日志，不把未捕获的 rejection 留给进程', async () => {
    fakeClock();
    const h = await harness();
    h.claim.mockRejectedValue(new Error('connection lost'));
    const sink = captureLogs(h.service);

    h.service.start();
    await vi.advanceTimersByTimeAsync(UPLOAD_WORKER_POLL_MS);

    expect(sink.error.map(([message]) => String(message)).join()).toContain('取任务失败');
    h.service.stop();
  });
});

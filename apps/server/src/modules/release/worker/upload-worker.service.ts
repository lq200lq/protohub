import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { rm } from 'node:fs/promises';
import {
  ERROR_CODES,
  type UploadTaskErrorCode,
  type UploadTaskStage,
  type UploadTaskWarning,
} from '@protohub/shared';

import { prototypeAccessPath } from '../../../common/access-path';
import { BusinessException } from '../../../common/exception/business.exception';
import { AppEnvService } from '../../../config/app-env.service';
import {
  UPLOAD_TASK_MAX_RETRY,
  UPLOAD_TASK_STALE_MS,
  UPLOAD_WORKER_POLL_MS,
  UPLOAD_WORKER_SWEEP_MS,
} from '../../../config/constants';
import {
  requireLocalPath,
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../../storage/storage.adapter';
import { workDirKey } from '../../storage/storage-keys';
import {
  PrototypeDeletedError,
  ReleaseCommitter,
  type CommitInput,
} from '../pipeline/commit';
import {
  uploadErrorCodeOf,
  uploadErrorText,
  uploadLimitsOf,
  type UploadLimits,
} from '../pipeline/errors';
import { extractZipToWorkDir } from '../pipeline/extract';
import { sha256OfFile } from '../pipeline/hash';
import {
  postprocessWorkDir,
  type PostprocessResult,
} from '../pipeline/postprocess';
import { stageProgress } from '../pipeline/progress';
import { assertInspectable, inspectZip } from '../pipeline/validate';
import {
  UploadTaskRepo,
  type ClaimedTask,
  type ClaimOwnership,
  type ReclaimResult,
} from './upload-task.repo';

/**
 * 发布 Worker（机制 §3.3 + §2.1②③④，计划 M3-T4）：把受理落库的任务跑完整条流水线。
 *
 * 分工边界——这一层只做"取任务 → 按阶段调流水线 → 回填任务行"，四件判定都不在它手里：
 * - 校验与阈值在 `validate.ts` / `extract.ts`（与受理共用同一批函数，两趟不可能口径漂移）；
 * - 入口、脱壳、改写、清单在 `postprocess.ts`；
 * - 版本行、指针、事件的写入顺序在 `commit.ts`（§3.1）；
 * - 任务行的取、回填、巡检在 `upload-task.repo.ts`（§3.3）。
 *
 * 三个由 §3.2/§3.3 推出的形状：
 *
 * 1. **串行消费**（`MAX_CONCURRENT_TASKS=1`）：解压是磁盘密集型，并发只会让所有任务一起变慢。
 *    上限读 env 而不是写死，是因为 §3.3 特意选了 `SKIP LOCKED`——将来多开实例就能并行消费、
 *    不改代码（决策 D-16）。
 * 2. **只在阶段边界检查任务归属**：`onBytes` 是解压内部的同步回调，那儿没法 await 写库，
 *    所以进度写排进一条链、边界处 `guard()` 汇合。一旦发现任务被巡检捞走，本进程立刻停止写库，
 *    也**不删工作目录**——新接管者正在用同一个目录（它开工先清空，见 `extract.ts` 的"不信任③"）。
 *    归属在两个边界之间被换走时终态写会落空（repo 的不变量 2 让它匹配不到行），处理一致：停手、不动盘。
 * 3. **失败只清工作目录，不删原始包**：`tmp/work-{taskId}/` 是这一次尝试的中间产物，删掉就完事；
 *    `tmp/upload-{taskId}-{random}.zip` 是任务重投（§3.2）时还要再读一遍的输入，删了就没法重试。
 *    留在磁盘上的最坏情况都由 §4.3 的"超过 24 小时的 `tmp/**` 一律删除"兜底。
 *    唯一的例外是 §3.2 点名"并清理 tmp"的 `PROTO_NOT_FOUND`：重投必然撞同一堵墙，包留着没意义。
 */

/** 任务已被巡检捞走：停止写库，也不再做任何磁盘动作。 */
class TaskAbandonedError extends Error {
  constructor(readonly taskId: bigint) {
    super(`任务 ${String(taskId)} 已不属于本处理者，停止回填`);
    this.name = 'TaskAbandonedError';
  }
}

/**
 * 进度回填的节流器。三件事互相咬合，所以放在同一个类里：
 *
 * 1. **同值不写**：解压每读一块回调一次，一次发布能回调上万次，而进度只有 0-100 个格子。
 *    `(stage, progress)` 没变就直接返回，写库次数从"每块一次"降到"每格一次"。
 * 2. **写库串行**：所有写排进一条 promise 链，后一次等前一次落地。并发写会让"60"晚于"72"到达，
 *    用户的进度条就会倒退。
 * 3. **丢行即停**：`patchProgress()` 返回 false 意味着这一次领取已经作废——行上的 `status` 不再
 *    是 `processing`，或 `started_at` 已经不是本处理者写入的那个时刻（被 §3.2 的巡检重置过）。
 *    两种都说明本进程不再是它的处理者；置 `lost` 让流水线在下一个边界停手。
 *    写库抛异常同样按"丢了"处理——不确定归属时宁可停手，交给巡检或接管者收尾。
 */
class TaskProgress {
  lost = false;

  private readonly logger = new Logger(TaskProgress.name);
  private lastWritten: null | string = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tasks: UploadTaskRepo,
    private readonly ownership: ClaimOwnership,
  ) {}

  push(stage: UploadTaskStage, ratio: number): void {
    const progress = stageProgress(stage, ratio);
    const key = `${stage}:${String(progress)}`;
    if (key === this.lastWritten) {
      return;
    }
    this.lastWritten = key;
    this.tail = this.tail.then(async () => {
      if (this.lost) {
        return;
      }
      try {
        this.lost = !(await this.tasks.patchProgress(this.ownership, stage, progress));
      } catch (error: unknown) {
        this.lost = true;
        this.logger.error(
          `任务 ${String(this.ownership.taskId)} 进度回填失败，按"已被捞走"处理：${messageOf(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    });
  }

  /** 阶段边界：等已排队的写落地；任务已被捞走就抛，让调用方跳出流水线。 */
  async guard(): Promise<void> {
    await this.tail;
    if (this.lost) {
      throw new TaskAbandonedError(this.ownership.taskId);
    }
  }
}

@Injectable()
export class UploadWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UploadWorkerService.name);
  private inFlight = 0;
  private pollTimer: null | NodeJS.Timeout = null;
  private sweepTimer: null | NodeJS.Timeout = null;

  constructor(
    private readonly tasks: UploadTaskRepo,
    private readonly committer: ReleaseCommitter,
    private readonly appEnv: AppEnvService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * 开机先巡检一次（§3.2 的"启动时与每 5 分钟"），再挂 1 秒轮询与 5 分钟巡检。
   *
   * 幂等：重复调用不叠第二份轮询。`claim()` 是 `SKIP LOCKED`，两份定时器不会咬同一行，
   * 但会把 §3.3 要求的串行变成两路并发。
   */
  start(): void {
    if (this.pollTimer !== null) {
      return;
    }
    this.sweepTimer = this.every(() => this.sweep(), UPLOAD_WORKER_SWEEP_MS, '超时巡检');
    this.pollTimer = this.every(() => this.tick(), UPLOAD_WORKER_POLL_MS, '取任务');
    this.drain(this.sweep(), '启动巡检');
  }

  stop(): void {
    for (const timer of [this.pollTimer, this.sweepTimer]) {
      if (timer !== null) {
        clearInterval(timer);
      }
    }
    this.pollTimer = null;
    this.sweepTimer = null;
  }

  /**
   * 超时巡检：把停在 `processing` 且超过 10 分钟的任务捞回 `pending`（重投一次）或直接判失败。
   * 判据与写库都在 `upload-task.repo.ts`，这里只给"多久算卡死"和"允许重投几次"。
   */
  async sweep(): Promise<ReclaimResult> {
    const result = await this.tasks.reclaimStale(
      new Date(Date.now() - UPLOAD_TASK_STALE_MS),
      UPLOAD_TASK_MAX_RETRY,
    );
    if (result.requeued > 0 || result.failed > 0) {
      this.logger.log(
        `超时巡检：重新排队 ${String(result.requeued)} 条，判失败 ${String(result.failed)} 条`,
      );
    }
    return result;
  }

  /**
   * 取一条任务并跑完整条流水线，返回是否真的处理了任务。
   * 定时器与测试共用这个入口——计划 M3-T4 的判据"杀掉进程再起，`processing` 任务回到 `pending`
   * 并自动完成"就是 `sweep()` + `tick()` 这两步。
   */
  async tick(): Promise<boolean> {
    if (this.inFlight >= this.appEnv.env.release.maxConcurrentTasks) {
      return false;
    }
    // 受理阶段的 validating 已经在请求里跑完，Worker 从 extracting 起算（§2.1 的区间表）。
    const task = await this.tasks.claim('extracting');
    if (task === null) {
      return false;
    }
    this.inFlight += 1;
    try {
      await this.processTask(task);
    } finally {
      this.inFlight -= 1;
    }
    return true;
  }

  private every(
    run: () => Promise<unknown>,
    everyMs: number,
    label: string,
  ): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.drain(run(), label);
    }, everyMs);
    // 定时器不钉住事件循环：应用关掉后进程就该退出（集成测试尤其吃这一点）。
    timer.unref();
    return timer;
  }

  private drain(promise: Promise<unknown>, label: string): void {
    void promise.catch((error: unknown) => {
      // 定时器里绝不留未捕获的 rejection：一次数据库抖动就会把整个进程带下去。
      this.logger.error(
        `${label}失败：${messageOf(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }

  private async processTask(task: ClaimedTask): Promise<void> {
    const limits = uploadLimitsOf(this.appEnv.env.upload);
    const workDir = requireLocalPath(this.storage, workDirKey(String(task.id)));
    const progress = new TaskProgress(this.tasks, task.ownership);
    let stage: UploadTaskStage = 'extracting';
    let warnings: readonly UploadTaskWarning[] = [];
    let sourceZip: null | string = null;

    try {
      sourceZip = this.sourceZipOf(task);
      // 受理趟的结论不在这儿（Worker 手里只有任务行），重读一次中央目录：秒级、不解压字节，
      // 既拿到解压总量当进度分母，也把"受理与处理之间文件被换掉/被截断"重新判一遍（§2.1 的不信任）。
      const inspection = await inspectZip(sourceZip, limits);
      assertInspectable(inspection, task.sourceSize, limits);
      // §2.7 的 `source_hash` 打在原始包上、是下次发布去重的依据，而任务行没存受理时算的那个值，
      // 这里是唯一能补上它的地方。放在解压前：让"包已经不在了"这种失败早一点、便宜一点发生。
      const sourceHash = await sha256OfFile(sourceZip);

      const extracted = await extractZipToWorkDir({
        limits,
        onBytes: (doneBytes) => {
          // 分母是中央目录声明的解压总量（只用来画比例，不参与判定，见 ExtractInput.totalBytesHint）。
          // 兜成 1 是为了全零字节的包：0/0 是 NaN，进度条会停在起点而不是走完。
          progress.push('extracting', doneBytes / Math.max(1, inspection.totalUncompressed));
        },
        sourceZip,
        totalBytesHint: inspection.totalUncompressed,
        workDir,
      });
      await progress.guard();

      stage = 'postprocess';
      progress.push('postprocess', 0);
      const posted = await postprocessWorkDir({
        files: extracted.files,
        limits,
        onProgress: (ratio) => {
          progress.push('postprocess', ratio);
        },
        prefixPath: prototypeAccessPath(task.projectCode, task.prototypeCode),
        skipped: extracted.skipped,
        workDir,
      });
      warnings = posted.manifest.warnings;
      await progress.guard();

      stage = 'committing';
      progress.push('committing', 0);
      await progress.guard();
      const committed = await this.committer.commit(
        commitInputOf(task, posted, sourceHash, workDir),
      );
      const written = await this.tasks.markSuccess(task.ownership, {
        releaseId: committed.releaseId,
        stage: 'committing',
        warnings: posted.manifest.warnings,
      });
      if (!written) {
        // 归属在本次提交期间被换走（巡检捞走 → 接管者重新 processing）。
        // 版本行已经按 §3.1 落地，这里只如实记下"任务终态没写进去"，不去盖接管者的状态。
        this.logger.warn(
          `任务 ${String(task.id)} 发布完成但终态回填落空：版本 ${String(committed.versionNo)} 已生效，任务行已归属其他处理者`,
        );
        return;
      }
      this.logger.log(
        `任务 ${String(task.id)} 发布完成：版本 ${String(committed.versionNo)} → ${committed.storageKey}`,
        {
          prototypeId: String(task.prototypeId),
          releaseId: String(committed.releaseId),
          taskId: String(task.id),
        },
      );
    } catch (error: unknown) {
      if (error instanceof TaskAbandonedError) {
        this.logger.warn(
          `任务 ${String(task.id)} 已被巡检捞走，本次处理停止（工作目录留给接管者）`,
        );
        return;
      }
      const failure = failureOf(error, limits);
      // 终态回填带归属令牌（repo 的不变量 2）：迟到的写匹配不到行，盖不掉接管者正在跑的状态。
      const written = await this.tasks.markFailure(task.ownership, {
        ...failure,
        stage,
        warnings,
      });
      if (!written) {
        this.logger.warn(
          `任务 ${String(task.id)} 的失败判写落空：这一行已归属其他处理者，本次结果 (${failure.errorCode}) 不作为终态`,
        );
        // 归属不在手上就别再动盘：工作目录正被接管者读写，原始包是它下一次尝试的输入。
        // 这两个目录/文件最终都由 §4.3 的"tmp 超 24 小时一律删除"收尾。
        return;
      }
      this.logger.error(
        `任务 ${String(task.id)} 在 ${stage} 阶段失败（${failure.errorCode}）：${failure.errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      // 尽力回收这一次尝试留下的工作目录；删不动也不追（§4.3 的 tmp 超 24 小时规则会收）。
      await rm(workDir, { force: true, recursive: true }).catch(() => undefined);
      // §3.2 在"原型/项目被删除"这一行点名"清理 tmp"：这条失败重投只会撞同一堵墙，
      // 原始包留着没有意义，而留着它还让 GC 等到 24 小时之后才收。
      if (error instanceof PrototypeDeletedError && sourceZip !== null) {
        await rm(sourceZip, { force: true }).catch(() => undefined);
      }
    }
  }

  private sourceZipOf(task: ClaimedTask): string {
    if (task.tempKey === null) {
      throw new BusinessException(
        '任务没有可用的临时文件，请重新发布',
        ERROR_CODES.UPLOAD_WORKER_FAILED,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return requireLocalPath(this.storage, task.tempKey);
  }
}

function commitInputOf(
  task: ClaimedTask,
  posted: PostprocessResult,
  sourceHash: string,
  workDir: string,
): CommitInput {
  return {
    contentHash: posted.contentHash,
    createdBy: task.createdBy,
    entry: posted.entry,
    manifest: posted.manifest,
    note: task.note,
    projectId: task.projectId,
    prototypeId: task.prototypeId,
    sourceHash,
    sourceSize: task.sourceSize,
    workDir,
  };
}

/** 失败码与那句人话：§3.2 点名的"原型被删"单独一支，其余收敛进 §8 的码表。 */
function failureOf(
  error: unknown,
  limits: UploadLimits,
): { errorCode: UploadTaskErrorCode; errorMessage: string } {
  if (error instanceof PrototypeDeletedError) {
    return { errorCode: ERROR_CODES.PROTO_NOT_FOUND, errorMessage: error.message };
  }
  const errorCode = uploadErrorCodeOf(error);
  // BusinessException 的 message 已经是 `uploadRejected()` 现算的人话（还带具体条目），原样留着；
  // 非上传异常（程序 bug、驱动报错）不能把原始文案塞给用户，换成 §8 的兜底话术。
  const errorMessage =
    error instanceof BusinessException ? error.message : uploadErrorText(errorCode, limits);
  return { errorCode, errorMessage };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ERROR_CODES,
  isUploadTaskErrorCode,
  UPLOAD_TASK_STAGES,
  UPLOAD_TASK_STATUSES,
  type UploadTaskErrorCode,
  type UploadTaskStage,
  type UploadTaskStatus,
  type UploadTaskWarning,
} from '@protohub/shared';

import { PRISMA_CLIENT } from '../../system/persistence/prisma-token';
import { stageStartProgress } from '../pipeline/progress';
import { toWarnings, warningsToJson } from '../warnings-codec';

/**
 * 发布任务队列的取/回填/巡检（机制 §3.3 + §3.2 + 数据库设计 §4.2.6）。
 *
 * 队列就是这张表，不是内存队列：`FOR UPDATE SKIP LOCKED` 让"多开一个实例就能并行消费"
 * 成为部署时的事，不用改代码（决策 D-16）。这一层只**写**任务行，不碰 release/prototype——
 * 版本行的写入顺序由 `pipeline/commit.ts` 按 §3.1 负责，两边各管一张表才不会互相插队。
 * （读任务时顺带 join 原型与项目拿两段编码是另一回事：那是 §5.3 响应体的必需字段。）
 *
 * 三个不变量：
 * 1. **取到即占**：`claim()` 在一个事务里"选中 + 置 processing"，锁随事务释放，
 *    另一个实例此刻查到的是已经变成 processing 的行，不会被同一任务咬两口。
 * 2. **回填只认"自己那一次领取"**：所有进度/终态写入都带 `status='processing'` **且**
 *    `started_at` 等于本次 `claim()` 拿到的那个时刻。只带 status 是不够的：超时巡检把行捞回
 *    `pending`、新接管者再把它置回 `processing` 之后，僵尸处理者的迟到写入照样能匹配上这一行，
 *    于是进度会倒退、终态会把接管者正在跑的任务判成 `failed`，接管者随后的写入全部落空。
 *    `started_at` 在重投时被清成 null、再被新 `claim()` 赋成新时刻，因此等值比对就是"归属令牌"。
 * 3. **重投只有一次**：`retry_count` 的上界写在 SQL 里，也由库的 CHECK(0..1) 兜底。
 */

/** `proto_upload_task.error_message` 是 varchar(500)。 */
const ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * 一次领取的归属：`taskId` 定位行，`startedAt` 证明"还是这次领取在处理它"。
 * 之后所有回填都要带上它（不变量 2），所以它跟着 `ClaimedTask` 一路传到 Worker。
 */
export interface ClaimOwnership {
  readonly startedAt: Date;
  readonly taskId: bigint;
}

export interface ClaimedTask {
  /** 这次领取的归属令牌（写回填时用它定位"还是我在处理"，见 `ClaimOwnership`）。 */
  readonly ownership: ClaimOwnership;
  readonly createdBy: bigint;
  /** 受理时如果没带 temp_key（历史行/人工改库），Worker 无事可做；如实交出去，不猜路径。 */
  readonly tempKey: null | string;
  readonly id: bigint;
  readonly note: null | string;
  readonly projectCode: string;
  readonly projectId: bigint;
  readonly prototypeCode: string;
  readonly prototypeId: bigint;
  readonly retryCount: number;
  readonly sourceName: string;
  readonly sourceSize: number;
}

/**
 * 终态写入的两个补丁形状。警告用 shared 的契约类型 `UploadTaskWarning`：
 * 它的形状就是接口设计 §5.3 的 `warnings[]`，界面按同一份形状渲染发布报告（§3.7 一处定义）。
 */
export interface SuccessPatch {
  readonly releaseId: bigint;
  readonly stage: UploadTaskStage;
  readonly warnings: readonly UploadTaskWarning[];
}

export interface FailurePatch {
  readonly errorCode: UploadTaskErrorCode;
  readonly errorMessage: string;
  readonly stage: null | UploadTaskStage;
  readonly warnings: readonly UploadTaskWarning[];
}

export interface ReclaimResult {
  readonly failed: number;
  readonly requeued: number;
}

/**
 * §5.3 轮询要的那份任务视图：只有任务行自己的列，加上它那条原型的两段编码
 * （访问路径 `/p/{项目码}/{原型码}` 由它们拼，见 common/access-path.ts）。
 *
 * 数据范围不在这里判（那是 `PrototypeRepo.findAccessible` 那一处实现的事，服务层紧接着查），
 * 本层也不查 `proto_release`：成功时的版本摘要归 `version/version.repo.ts`，
 * 两边各管一张表，和 §3.3 那条"队列与版本写入互不插队"是同一个分工。
 */
export interface TaskStatusRow {
  readonly errorCode: null | UploadTaskErrorCode;
  readonly errorMessage: null | string;
  readonly id: bigint;
  readonly progress: number;
  readonly projectCode: string;
  readonly projectId: bigint;
  readonly prototypeCode: string;
  readonly prototypeId: bigint;
  readonly releaseId: null | bigint;
  readonly sourceName: string;
  readonly sourceSize: number;
  readonly stage: null | UploadTaskStage;
  readonly status: UploadTaskStatus;
  readonly warnings: readonly UploadTaskWarning[];
}

@Injectable()
export class UploadTaskRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /**
   * 取一条 pending 并立刻置 processing（§3.3）。
   * 顺序按 `created_at, id`：先提交的先完成，串行时体感就是队列；`id` 只用来让同一毫秒内
   * 的多条也有确定次序（Postgres 对并列值不保证稳定，缺它时"谁先跑"会随执行计划变）。
   */
  async claim(startStage: UploadTaskStage): Promise<ClaimedTask | null> {
    return this.db.$transaction(async (client) => {
      const picked = await client.$queryRaw<Array<{ id: bigint }>>`
        select id
        from proto_upload_task
        where status = 'pending'
        order by created_at, id
        limit 1
        for update skip locked`;
      const first = picked[0];
      if (!first) {
        // 没有任务，或唯一的候选正被别的实例锁着：两种都该安静地返回 null，下一轮再来。
        return null;
      }
      // 先把时刻算在手里再写库：回填要比对的正是这个值，读回来再取一次反而多一个不一致的来源。
      const startedAt = new Date();
      const task = await client.protoUploadTask.update({
        data: {
          progress: stageStartProgress(startStage),
          stage: startStage,
          startedAt,
          status: 'processing',
        },
        include: {
          prototype: { include: { project: { select: { code: true, id: true } } } },
        },
        where: { id: first.id },
      });
      return toClaimedTask(task, { startedAt, taskId: task.id });
    });
  }

  /**
   * 回填阶段与进度。
   * 返回是否真的写到了：`false` 表示这一次领取已经作废（被巡检捞走重投、或已写终态），
   * 调用方（Worker）据此停止后续回填。
   */
  async patchProgress(
    ownership: ClaimOwnership,
    stage: UploadTaskStage,
    progress: number,
  ): Promise<boolean> {
    const updated = await this.db.protoUploadTask.updateMany({
      data: { progress, stage },
      where: ownerWhere(ownership),
    });
    return updated.count > 0;
  }

  /** 成功终态：progress 固定 100、指向新版本（§3.1 第 4 步）。 */
  async markSuccess(ownership: ClaimOwnership, patch: SuccessPatch): Promise<boolean> {
    const updated = await this.db.protoUploadTask.updateMany({
      data: {
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date(),
        progress: 100,
        releaseId: patch.releaseId,
        stage: patch.stage,
        status: 'success',
        warnings: warningsToJson(patch.warnings),
      },
      where: ownerWhere(ownership),
    });
    return updated.count > 0;
  }

  /** 失败终态：错误码与"下一步做什么"的话一起落库，界面直接读（§8.2）。 */
  async markFailure(ownership: ClaimOwnership, patch: FailurePatch): Promise<boolean> {
    const updated = await this.db.protoUploadTask.updateMany({
      data: {
        errorCode: patch.errorCode,
        errorMessage: patch.errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        finishedAt: new Date(),
        stage: patch.stage,
        status: 'failed',
        warnings: warningsToJson(patch.warnings),
      },
      where: ownerWhere(ownership),
    });
    return updated.count > 0;
  }

  /**
   * 超时巡检（§3.2「超 10 分钟重置为 pending 并重试一次；第二次仍失败则置 failed」）。
   *
   * 判据是 `started_at < 界`：进程被 kill 后没人给它续期，这条正是为"没人管了"设计的。
   * 重投时把 `progress/stage/started_at` 一起清掉——用户看到的是一条全新的排队任务，
   * 而不是停在 37% 的僵尸。留下的 `tmp/work-{taskId}/` 交给 GC（§4.3），
   * 这里不做目录操作：删盘的活儿只归 GC 一处。
   */
  async reclaimStale(olderThan: Date, maxRetry: number): Promise<ReclaimResult> {
    const failed = await this.db.$executeRaw`
      update proto_upload_task
      set status = 'failed',
          finished_at = now(),
          error_code = 'UPLOAD_WORKER_FAILED',
          error_message = '处理超时，已自动重试一次仍未完成；请重新发布，或把 traceId 提供给运维'
      where status = 'processing'
        and started_at < ${olderThan}
        and retry_count >= ${maxRetry}`;
    const requeued = await this.db.$executeRaw`
      update proto_upload_task
      set status = 'pending',
          started_at = null,
          stage = null,
          progress = 0,
          retry_count = retry_count + 1
      where status = 'processing'
        and started_at < ${olderThan}
        and retry_count < ${maxRetry}`;
    return { failed, requeued };
  }

  /**
   * §5.3：按 id 读一条任务的当前状态。
   * 读的是任务行的实时值而不是缓存——Worker 每秒被回填一次，界面要的就是这个节奏。
   */
  async findForStatus(taskId: bigint): Promise<TaskStatusRow | null> {
    const entity = await this.db.protoUploadTask.findFirst({
      select: TASK_STATUS_SELECT,
      where: { id: taskId },
    });
    return entity === null ? null : toStatusRow(entity);
  }
}

type TaskWithRelations = Prisma.ProtoUploadTaskGetPayload<{
  include: { prototype: { include: { project: { select: { code: true; id: true } } } } };
}>;

const TASK_STATUS_SELECT = {
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
} satisfies Prisma.ProtoUploadTaskSelect;

type TaskStatusEntity = Prisma.ProtoUploadTaskGetPayload<{
  select: typeof TASK_STATUS_SELECT;
}>;

function toStatusRow(entity: TaskStatusEntity): TaskStatusRow {
  return {
    // 库里这几列是 varchar + CHECK（迁移原生 SQL），读回来时收敛成联合类型，越界值按最保守取值
    // （同 PrototypeRepo.toRow）。未知的 status 一律当已结束，否则前端会按 §5.3 的节奏一直轮下去。
    errorCode: toErrorCode(entity.errorCode),
    errorMessage: entity.errorMessage,
    id: entity.id,
    progress: entity.progress,
    projectCode: entity.prototype.project.code,
    projectId: entity.prototype.project.id,
    prototypeCode: entity.prototype.code,
    prototypeId: entity.prototypeId,
    releaseId: entity.releaseId,
    sourceName: entity.sourceName,
    sourceSize: Number(entity.sourceSize),
    stage: toStage(entity.stage),
    status: toStatus(entity.status),
    warnings: toWarnings(entity.warnings),
  };
}

function toErrorCode(value: null | string): null | UploadTaskErrorCode {
  if (value === null) {
    return null;
  }
  return isUploadTaskErrorCode(value) ? value : ERROR_CODES.UPLOAD_WORKER_FAILED;
}

function toStage(value: string | null): null | UploadTaskStage {
  return value !== null && (UPLOAD_TASK_STAGES as readonly string[]).includes(value)
    ? (value as UploadTaskStage)
    : null;
}

function toStatus(value: string): UploadTaskStatus {
  return (UPLOAD_TASK_STATUSES as readonly string[]).includes(value)
    ? (value as UploadTaskStatus)
    : 'failed';
}

/**
 * 回填的唯一 where（不变量 2 的落点）：行是这个任务、状态还在 processing、**且** `started_at`
 * 仍是本次领取写进去的那个时刻。第三项才是关键——巡检重投会把它清成 null 再由新 `claim()` 赋新值，
 * 于是僵尸处理者的迟到写入在这里匹配不到行，盖不到接管者头上。
 */
function ownerWhere(ownership: ClaimOwnership): Prisma.ProtoUploadTaskWhereInput {
  return {
    id: ownership.taskId,
    startedAt: ownership.startedAt,
    status: 'processing',
  };
}

function toClaimedTask(
  task: TaskWithRelations,
  ownership: ClaimOwnership,
): ClaimedTask {
  return {
    createdBy: task.createdBy,
    id: task.id,
    note: task.note,
    ownership,
    projectCode: task.prototype.project.code,
    projectId: task.prototype.project.id,
    prototypeCode: task.prototype.code,
    prototypeId: task.prototypeId,
    retryCount: task.retryCount,
    sourceName: task.sourceName,
    // 落库是 bigint，处理时只用到字节数；转成 number 让流水线不用到处 BigInt 运算。
    sourceSize: Number(task.sourceSize),
    tempKey: task.tempKey,
  };
}

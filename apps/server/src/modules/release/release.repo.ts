import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { genProjectCode, nextGeneratedPrototypeCode } from '@protohub/shared';

import {
  projectCodeExhaustedError,
  projectCodeRaceError,
  prototypeCodeExhaustedError,
  prototypeCodeRaceError,
} from '../../common/code-feedback';
import { CODE_AUTOGEN_MAX_RETRY } from '../../config/constants';
import { ProjectRepo } from '../project/project.repo';
import { PrototypeRepo } from '../prototype/prototype.repo';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 受理落库（机制 §3.0 + 后端接口设计 §5.1）。
 *
 * 这里是 M3 里唯一"一次写多张表"的地方，三条都来自 §3.0，一条不能松：
 * 1. **一个事务**：project(draft)/prototype(draft)/task 要么一起有，要么一个都没有。
 *    轻校验没过时根本走不到这里——"不合格不落任何库记录"（计划 M3-T2 判据）靠调用顺序保证。
 * 2. **编码唯一约束提前生效**：抢码在这一步就失败，而不是解压全跑完才发现（§3.0 的理由①）。
 * 3. **自动码冲突重试整个事务**：PG 里一条语句失败就废掉当前事务，没法"跳过这条继续"，
 *    所以重试单位是事务，不是语句。
 *
 * `note` 落在任务行上：版本说明属于 release，而 release 要到 §3.1 第 3 步才建，
 * Worker 唯一能读到的输入就是这条任务行（见计划 §9 DEV-18）。
 */

type TxClient = Prisma.TransactionClient;

export interface AcceptRef {
  readonly code: string | null;
  readonly description: string | null;
  readonly name: string;
}

export type AcceptTarget =
  | { readonly kind: 'append'; readonly prototypeId: bigint }
  | { readonly kind: 'createPrototype'; readonly projectId: bigint; readonly prototype: AcceptRef }
  | {
      readonly kind: 'createProject';
      readonly project: AcceptRef;
      readonly prototype: AcceptRef;
    };

export interface AcceptInput {
  readonly createdBy: bigint;
  readonly idempotencyKey: string | null;
  readonly note: string | null;
  readonly sourceName: string;
  readonly sourceSize: number;
  /** 受理时文件所在的过渡 key；事务提交后 rename 成 §1.2 的正式名再回填（见计划 §9 DEV-17）。 */
  readonly tempKey: string;
}

export interface AcceptedRelease {
  readonly projectCode: string;
  readonly projectId: bigint;
  /** 访问路径两段编码在受理时就定下来了（§3.0 提前抢码的直接收益），前端当场能显示链接。 */
  readonly prototypeCode: string;
  readonly prototypeId: bigint;
  readonly taskId: bigint;
}

export interface IdempotentHit {
  readonly projectCode: string;
  readonly projectId: bigint;
  readonly prototypeCode: string;
  readonly prototypeId: bigint;
  readonly taskId: bigint;
}

/**
 * 事务走到哪一步（也是撞唯一索引时的责任归属）：a. 项目 → b. 原型 → c. 任务。
 * Prisma 对**裸 SQL 建的条件唯一索引**（`uk_proto_prototype_code`）给不出可靠 `meta.target`，
 * 所以不猜约束名，只认这里推进过的位置。
 */
type AcceptStep = 'project' | 'prototype' | 'task';

@Injectable()
export class ReleaseRepo {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly projects: ProjectRepo,
    private readonly prototypes: PrototypeRepo,
  ) {}

  /**
   * §3.0 的受理事务，带自动码重试。
   * 只有**自动生成的编码**撞唯一索引才值得重试（D-20）；手填码在 service 里预查过占用，
   * 这里再撞就是并发抢码 → 409 让人重新检查（§1.4）。
   */
  async accept(target: AcceptTarget, input: AcceptInput): Promise<AcceptedRelease> {
    let lastConflict: AcceptStep = 'task';
    for (let attempt = 1; attempt <= CODE_AUTOGEN_MAX_RETRY; attempt += 1) {
      const progress: { step: AcceptStep } = { step: 'task' };
      try {
        return await this.acceptOnce(target, input, progress);
      } catch (error: unknown) {
        if (!this.prototypes.isCodeConflict(error)) {
          throw error;
        }
        lastConflict = progress.step;
        if (isAutoCodeConflict(target, lastConflict)) {
          continue;
        }
        if (lastConflict === 'task') {
          // 任务表没有任何唯一索引，走到这里说明撞的是别的东西——原样抛，让人看见，不换个说法掩盖。
          throw error;
        }
        throw lastConflict === 'project'
          ? projectCodeRaceError()
          : prototypeCodeRaceError();
      }
    }
    throw lastConflict === 'project'
      ? projectCodeExhaustedError()
      : prototypeCodeExhaustedError();
  }

  private async acceptOnce(
    target: AcceptTarget,
    input: AcceptInput,
    progress: { step: AcceptStep },
  ): Promise<AcceptedRelease> {
    return this.db.$transaction(async (client) => {
      let projectId: bigint;
      let projectCode: string;
      if (target.kind === 'createProject') {
        projectCode = target.project.code ?? genProjectCode();
        progress.step = 'project';
        projectId = await this.projects.createOn(client, {
          code: projectCode,
          createdBy: input.createdBy,
          description: target.project.description,
          name: target.project.name,
        });
        // 创建者必须是 owner：数据范围（权限模型 §6.2）按成员表判定，不加成就会看不见自己刚建的项目。
        await this.projects.addMemberOn(client, {
          createdBy: input.createdBy,
          memberRole: 'owner',
          projectId,
          userId: input.createdBy,
        });
      } else {
        projectId =
          target.kind === 'append'
            ? await this.projectIdOf(client, target.prototypeId)
            : target.projectId;
        projectCode = await this.projectCodeOf(client, projectId);
      }

      let prototypeId: bigint;
      let prototypeCode: string;
      if (target.kind === 'append') {
        prototypeId = target.prototypeId;
        prototypeCode = await this.prototypeCodeOf(client, prototypeId);
      } else {
        prototypeCode =
          target.prototype.code ??
          nextGeneratedPrototypeCode(
            projectCode,
            await this.prototypes.activeCodesInProjectOn(client, projectId),
          );
        progress.step = 'prototype';
        prototypeId = await this.prototypes.createOn(client, {
          code: prototypeCode,
          createdBy: input.createdBy,
          description: target.prototype.description,
          name: target.prototype.name,
          projectId,
        });
      }

      progress.step = 'task';
      const task = await client.protoUploadTask.create({
        data: {
          createdBy: input.createdBy,
          idempotencyKey: input.idempotencyKey,
          note: input.note,
          // §3.0 只要求 status='pending'；progress/stage 由 Worker 回填（§2.1 的 validating 已在请求内跑完）。
          progress: 0,
          prototypeId,
          sourceName: input.sourceName,
          sourceSize: BigInt(input.sourceSize),
          status: 'pending',
          tempKey: input.tempKey,
        },
        select: { id: true },
      });
      return {
        projectCode,
        projectId,
        prototypeCode,
        prototypeId,
        taskId: task.id,
      };
    });
  }

  /** §1.5 的幂等回放：同键 + 同人 + 窗口内，返回首次受理的结果（不重新落库、不再收一次文件）。 */
  async findRecentAcceptance(
    createdBy: bigint,
    idempotencyKey: string,
    since: Date,
  ): Promise<IdempotentHit | null> {
    const row = await this.db.protoUploadTask.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        prototype: {
          select: {
            code: true,
            id: true,
            project: { select: { code: true, id: true } },
          },
        },
      },
      where: { createdBy, createdAt: { gt: since }, idempotencyKey },
    });
    if (!row) {
      return null;
    }
    return {
      projectCode: row.prototype.project.code,
      projectId: row.prototype.project.id,
      prototypeCode: row.prototype.code,
      prototypeId: row.prototype.id,
      taskId: row.id,
    };
  }

  /**
   * §2.7 的去重依据：只看**当前生效版本**的 source_hash。
   * 历史版本相同不算重复——回滚后再发同一个包是正常路径，那时当前版本已经换人了。
   */
  async currentSourceHash(prototypeId: bigint): Promise<string | null> {
    const row = await this.db.protoPrototype.findUnique({
      select: { currentRelease: { select: { sourceHash: true } } },
      where: { id: prototypeId },
    });
    return row?.currentRelease?.sourceHash ?? null;
  }

  /** rename 之后把正式 key 回填进任务（§1.2 的 `tmp/upload-{taskId}-{random}.zip`）。 */
  async setTempKey(taskId: bigint, tempKey: string): Promise<void> {
    await this.db.protoUploadTask.update({
      data: { tempKey },
      where: { id: taskId },
    });
  }

  private async projectIdOf(client: TxClient, prototypeId: bigint): Promise<bigint> {
    const row = await client.protoPrototype.findUniqueOrThrow({
      select: { projectId: true },
      where: { id: prototypeId },
    });
    return row.projectId;
  }

  private async projectCodeOf(client: TxClient, projectId: bigint): Promise<string> {
    const row = await client.protoProject.findUniqueOrThrow({
      select: { code: true },
      where: { id: projectId },
    });
    return row.code;
  }

  private async prototypeCodeOf(client: TxClient, prototypeId: bigint): Promise<string> {
    const row = await client.protoPrototype.findUniqueOrThrow({
      select: { code: true },
      where: { id: prototypeId },
    });
    return row.code;
  }
}

/** 撞码的那一步用的是自动码吗？手填码重试还是同一个值，重试只是白跑一遍事务。 */
function isAutoCodeConflict(target: AcceptTarget, step: AcceptStep): boolean {
  if (step === 'project') {
    return target.kind === 'createProject' && target.project.code === null;
  }
  if (step === 'prototype') {
    return target.kind !== 'append' && target.prototype.code === null;
  }
  return false;
}

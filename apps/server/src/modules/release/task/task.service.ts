import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type ReleaseSummary,
  type UploadTaskError,
  type UploadTaskStatusResult,
} from '@protohub/shared';

import { accessUrlOf, prototypeAccessPath } from '../../../common/access-path';
import { toActorScope } from '../../../common/data-scope';
import { BusinessException } from '../../../common/exception/business.exception';
import { AppEnvService } from '../../../config/app-env.service';
import { PrototypeRepo } from '../../prototype/prototype.repo';
import type { Actor } from '../../system/common/actor';
import { parseIdParam } from '../../system/common/dto';
import { uploadLimitsOf, taskFailureMessageOf, type UploadLimits } from '../pipeline/errors';
import { VersionRepo, type ReleaseRow } from '../version/version.repo';
import { type TaskStatusRow, UploadTaskRepo } from '../worker/upload-task.repo';

/**
 * §5.3 任务状态（前端 1s 一次轮询这一条直到终态）。
 *
 * 读的是任务行本身：进度、阶段、警告、失败文案全在那一行里（机制 §8.2 把"下一步做什么"的那句话
 * 写在库中，界面直接读，不在前端按码重算）。这里只补两件事——
 * 1. **范围**：任务属于谁不由任务行自己说，一律先问父项目（权限模型 §6.2）；
 * 2. **摘要**：成功时按 `release_id` 取那一版的样子（版本行归 `VersionRepo` 读，与 §3.3 的分工一致）。
 */
@Injectable()
export class UploadTaskService {
  constructor(
    private readonly tasks: UploadTaskRepo,
    private readonly versions: VersionRepo,
    private readonly prototypes: PrototypeRepo,
    private readonly appEnv: AppEnvService,
  ) {}

  async status(actor: Actor, taskId: string): Promise<UploadTaskStatusResult> {
    const row = await this.tasks.findForStatus(parseIdParam(taskId, '任务 id'));
    if (row === null) {
      throw new BusinessException(
        '任务不存在或已被清理，请重新上传',
        ERROR_CODES.UPLOAD_TASK_NOT_FOUND,
        404,
      );
    }
    await this.prototypes.findAccessible(row.prototypeId, toActorScope(actor));

    const accessPath = prototypeAccessPath(row.projectCode, row.prototypeCode);
    return {
      error: toTaskError(row, uploadLimitsOf(this.appEnv.env.upload)),
      progress: row.progress,
      projectId: row.projectId.toString(),
      prototypeId: row.prototypeId.toString(),
      release:
        row.status === 'success' && row.releaseId !== null
          ? await this.summaryOf(row.releaseId, row, accessPath)
          : null,
      sourceName: row.sourceName,
      sourceSize: row.sourceSize,
      stage: row.stage,
      status: row.status,
      taskId: row.id.toString(),
      warnings: [...row.warnings],
    };
  }

  /**
   * 成功任务的版本摘要。
   *
   * `publishedAt` 用版本行自己的 `created_at`：机制 §3.1 里它就是"这一版生效的那一刻"，
   * 而原型的 `published_at` 会跟着下一次发布走，用它等于让每次轮询报出不同的发布时间。
   */
  private async summaryOf(
    releaseId: bigint,
    row: TaskStatusRow,
    accessPath: string,
  ): Promise<ReleaseSummary | null> {
    const release = await this.versions.findSummary(releaseId);
    return release === null ? null : toReleaseSummary(release, row, accessPath, this.baseUrl());
  }

  private baseUrl(): string {
    return this.appEnv.env.http.publicBaseUrl;
  }
}

/**
 * 失败详情。`message` 优先用库里那句（Worker 写终态时一起写入，可能带着具体条目路径），
 * 只有人工改坏的行才会落到 `taskFailureMessageOf()` 的按码兜底。
 */
function toTaskError(row: TaskStatusRow, limits: UploadLimits): UploadTaskError | null {
  if (row.status !== 'failed' || row.errorCode === null) {
    return null;
  }
  return {
    errorCode: row.errorCode,
    message: row.errorMessage ?? taskFailureMessageOf(row.errorCode, limits),
  };
}

function toReleaseSummary(
  release: ReleaseRow,
  row: TaskStatusRow,
  accessPath: string,
  baseUrl: string,
): ReleaseSummary {
  return {
    accessPath,
    accessUrl: accessUrlOf(baseUrl, accessPath),
    contentHash: release.contentHash,
    entryFile: release.entryFile,
    fileCount: release.fileCount,
    id: release.id.toString(),
    projectId: row.projectId.toString(),
    prototypeId: row.prototypeId.toString(),
    publishedAt: release.createdAt.toISOString(),
    totalBytes: release.totalBytes,
    versionNo: release.versionNo,
  };
}

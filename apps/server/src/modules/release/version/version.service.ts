import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type PageResult,
  type ProjectEventItem,
  type PrototypeDetail,
  type ReleaseEventItem,
  type ReleaseListItem,
} from '@protohub/shared';

import { toActorScope } from '../../../common/data-scope';
import { BusinessException } from '../../../common/exception/business.exception';
import type { NormalizedPageQuery } from '../../../common/pagination/pagination';
import { ProjectRepo } from '../../project/project.repo';
import { PrototypeRepo, type PrototypeRow } from '../../prototype/prototype.repo';
import { PrototypeService } from '../../prototype/prototype.service';
import type { Actor, RequestMeta } from '../../system/common/actor';
import { assertSortField, pageQueryFrom, parseIdParam } from '../../system/common/dto';
import { OperationAuditWriter } from '../../system/audit/operation-audit.writer';
import {
  type ProjectReleaseEventRow,
  releaseNotFoundError,
  RELEASE_EVENT_SORT_FIELDS,
  RELEASE_SORT_FIELDS,
  type ReleaseEventRow,
  type ReleaseRow,
  VersionRepo,
} from './version.repo';
import type { RollbackInput } from './version.dto';

/**
 * 版本视图与版本操作（后端接口设计 §5.4–§5.8）。
 *
 * 这个类的职责边界只有一条：**数据范围**。可见性一律先问 `PrototypeRepo.findAccessible` /
 * `ProjectRepo.findAccessible`（权限模型 §6.2，原型不单独判范围），拿到那条行自带的
 * `currentReleaseId` 再去标 `isCurrent`。业务规则（归档拦截、`status='ready'`、当前版本不能删）
 * 全部留在 `VersionRepo` 的那两个小事务里，紧挨着行锁执行——服务层读到的快照在进事务前就可能被人改，
 * 拿它做决定就是第二条真相。
 */
@Injectable()
export class VersionService {
  constructor(
    private readonly versions: VersionRepo,
    private readonly prototypes: PrototypeRepo,
    private readonly projects: ProjectRepo,
    private readonly prototypeService: PrototypeService,
    private readonly audit: OperationAuditWriter,
  ) {}

  /** §5.4 版本列表。`isCurrent` 由原型行决定，不额外查"哪版在用"。 */
  async list(
    actor: Actor,
    prototypeId: string,
    query: Record<string, unknown>,
  ): Promise<PageResult<ReleaseListItem>> {
    const scope = toActorScope(actor);
    const prototype = await this.prototypes.findAccessible(
      parseIdParam(prototypeId, '原型 id'),
      scope,
    );
    const page = normalizeVersionPage(query);
    const { rows, total } = await this.versions.listForPrototype(prototype.id, page);
    const sourceNames = await this.versions.sourceNamesOf(
      prototype.id,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => toReleaseListItem(row, prototype, sourceNames)),
      total,
    };
  }

  /**
   * §5.5 回滚。响应体是"更新后的原型详情"，所以直接复用 `PrototypeService.detail`——
   * 详情的字段口径（访问地址、当前版本摘要、成员）只在那一处实现，回滚不参与定义它。
   */
  async rollback(
    actor: Actor,
    prototypeId: string,
    input: RollbackInput,
    request: RequestMeta,
  ): Promise<PrototypeDetail> {
    const scope = toActorScope(actor);
    const prototype = await this.prototypes.findAccessible(
      parseIdParam(prototypeId, '原型 id'),
      scope,
    );
    const result = await this.versions.rollback({
      prototypeId: prototype.id,
      reason: input.reason ?? null,
      releaseId: parseIdParam(input.releaseId, '版本 id'),
      userId: BigInt(actor.userId),
    });
    await this.audit.record({
      actor,
      action: 'rollback',
      detail: {
        fromVersionNo: result.fromVersionNo,
        reason: input.reason ?? null,
        releaseId: input.releaseId,
        toVersionNo: result.toVersionNo,
      },
      module: 'proto:release',
      request,
      resourceId: prototype.id.toString(),
      resourceName: prototype.name,
      resourceType: 'prototype',
    });
    return this.prototypeService.detail(actor, prototype.id.toString());
  }

  /**
   * §5.6 标记删除版本。产物物理回收不在这里（那是 GC 的 M5-T6，机制 §4.3），
   * 本次只把版本从视图里摘掉并留下 `delete_version` 事件。
   */
  async removeRelease(
    actor: Actor,
    prototypeId: string,
    releaseId: string,
    request: RequestMeta,
  ): Promise<void> {
    const scope = toActorScope(actor);
    const prototype = await this.prototypes.findAccessible(
      parseIdParam(prototypeId, '原型 id'),
      scope,
    );
    const id = parseIdParam(releaseId, '版本 id');
    const outcome = await this.versions.markDeleted({
      prototypeId: prototype.id,
      releaseId: id,
      userId: BigInt(actor.userId),
    });
    if (outcome.kind === 'current') {
      throw new BusinessException(
        '当前生效版本不能删除：先回滚或发布别的版本，让这个链接指向另一版，再删它',
        ERROR_CODES.RELEASE_IS_CURRENT,
        400,
      );
    }
    if (outcome.kind === 'not-found') {
      throw releaseNotFoundError();
    }
    await this.audit.record({
      actor,
      action: 'delete',
      detail: {
        prototypeId: prototype.id.toString(),
        releaseId: id.toString(),
        versionNo: outcome.versionNo,
      },
      module: 'proto:release',
      request,
      resourceId: id.toString(),
      resourceName: outcome.versionNo === null ? null : `v${String(outcome.versionNo)}`,
      resourceType: 'release',
    });
  }

  /** §5.8 原型版本时间线。 */
  async prototypeEvents(
    actor: Actor,
    prototypeId: string,
    query: Record<string, unknown>,
  ): Promise<PageResult<ReleaseEventItem>> {
    const scope = toActorScope(actor);
    const prototype = await this.prototypes.findAccessible(
      parseIdParam(prototypeId, '原型 id'),
      scope,
    );
    const { rows, total } = await this.versions.listPrototypeEvents(
      prototype.id,
      normalizeEventPage(query),
    );
    return { items: rows.map(toReleaseEventItem), total };
  }

  /** §5.8 末段 项目级动态：同一张表按项目聚合，多原型名与原型码。 */
  async projectEvents(
    actor: Actor,
    projectId: string,
    query: Record<string, unknown>,
  ): Promise<PageResult<ProjectEventItem>> {
    const scope = toActorScope(actor);
    const project = await this.projects.findAccessible(
      parseIdParam(projectId, '项目 id'),
      scope,
    );
    const { rows, total } = await this.versions.listProjectEvents(
      project.id,
      normalizeEventPage(query),
    );
    return { items: rows.map(toProjectEventItem), total };
  }
}

/**
 * §5.3/§5.4 的 `publishedAt`：取那一版自己的 `created_at`。
 *
 * 不能用原型的 `published_at`——它跟着"最近一次发布/回滚"走，一条时间线里所有版本都会被写成同一个
 * 最新时间（版本列表就再也排不出"哪版是哪天发的"）。版本行的 `created_at` 在机制 §3.1 的提交事务里
 * 落库，正是"这一版生效的那一刻"。
 */
function toReleaseListItem(
  row: ReleaseRow,
  prototype: PrototypeRow,
  sourceNames: Map<string, string>,
): ReleaseListItem {
  return {
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
    entryFile: row.entryFile,
    fileCount: row.fileCount,
    id: row.id.toString(),
    isCurrent: row.id === prototype.currentReleaseId,
    note: row.note,
    report: [...row.report],
    sourceName: sourceNames.get(row.id.toString()) ?? null,
    sourceSize: row.sourceSize,
    status: row.status,
    totalBytes: row.totalBytes,
    versionNo: row.versionNo,
    warnings: { cssRewrites: row.cssRewrites, htmlRewrites: row.htmlRewrites },
  };
}

function toReleaseEventItem(row: ReleaseEventRow): ReleaseEventItem {
  return {
    createdAt: row.createdAt.toISOString(),
    eventType: row.eventType,
    fromVersionNo: row.fromVersionNo,
    id: row.id.toString(),
    operatorName: row.operatorName,
    reason: row.reason,
    toVersionNo: row.toVersionNo,
  };
}

function toProjectEventItem(row: ProjectReleaseEventRow): ProjectEventItem {
  return {
    ...toReleaseEventItem(row),
    prototypeCode: row.prototypeCode,
    prototypeName: row.prototypeName,
  };
}

function normalizeVersionPage(query: Record<string, unknown>): NormalizedPageQuery {
  const page = pageQueryFrom(query);
  return { ...page, sortBy: assertSortField(page.sortBy, RELEASE_SORT_FIELDS, 'versionNo') };
}

function normalizeEventPage(query: Record<string, unknown>): NormalizedPageQuery {
  const page = pageQueryFrom(query);
  return { ...page, sortBy: assertSortField(page.sortBy, RELEASE_EVENT_SORT_FIELDS, 'createdAt') };
}

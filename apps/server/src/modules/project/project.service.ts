import { Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  genProjectCode,
  validateProjectCode,
  type CodeCheckReason,
  type CodeCheckResult,
  type CodeInvalidReason,
  type MemberRole,
  type PageResult,
  type ProjectDetail,
  type ProjectListItem,
  type ProjectMemberInput,
  type ProjectMemberItem,
  type ProjectStatus,
  type ProjectUpdateResult,
} from '@protohub/shared';

import {
  assertProjectCodeFormat,
  projectCodeMessage,
  projectCodeExhaustedError,
  projectCodeRaceError,
  projectCodeTakenError,
} from '../../common/code-feedback';
import type { NormalizedPageQuery } from '../../common/pagination/pagination';
import { toActorScope } from '../../common/data-scope';
import { BusinessException } from '../../common/exception/business.exception';
import { CODE_AUTOGEN_MAX_RETRY } from '../../config/constants';
import type { Actor, RequestMeta } from '../system/common/actor';
import { buildChangeDiff } from '../system/common/audit-diff';
import { assertSortField, parseIdParam } from '../system/common/dto';
import { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import {
  createEmptyAggregates,
  PROJECT_AGGREGATE_SORTS,
  PROJECT_SCALAR_SORTS,
  ProjectRepo,
  type ProjectAggregates,
  type ProjectListFilter,
  type ProjectRow,
} from './project.repo';
import type {
  CreateProjectInput,
  SetProjectMembersInput,
  UpdateProjectInput,
} from './project.dto';

/** 接口设计 §4.1 的注里用的是 `sortBy=visits`，列名是 visitsLast7d；两种都认。 */
const SORT_ALIASES: Record<string, string> = { visits: 'visitsLast7d' };
const PROJECT_SORT_KEYS = [
  ...PROJECT_SCALAR_SORTS,
  ...PROJECT_AGGREGATE_SORTS,
  ...Object.keys(SORT_ALIASES),
];

function normalizeSortBy(sortBy: string | undefined): string | undefined {
  if (sortBy === undefined) {
    return undefined;
  }
  return SORT_ALIASES[sortBy] ?? sortBy;
}

/**
 * 项目（后端接口设计 §4.1/§4.2 + 决策 D-20/D-22）。
 *
 * 三条贯穿全类的规则：
 * 1. **范围判定只在 ProjectRepo**（权限模型 §6.2）：每条读/写都先过 `findAccessible`，
 *    "猜到 id 就能改别人的项目"（计划 §8 F-5）在这一层根本没有入口。
 * 2. **`status` 是派生值**（D-22）：由 archived_at 与其下原型的聚合算出，不落库、前端不再判断一遍。
 * 3. **编码不可改**（§4.1.5）：PUT 收到 `code` 也忽略，只在响应里回 PROTO_CODE_IMMUTABLE 警告。
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly repo: ProjectRepo,
    private readonly audit: OperationAuditWriter,
  ) {}

  /** §4.1.1 分页列表；聚合值按整页一次取齐，不在 map 里逐行查库。 */
  async list(
    actor: Actor,
    filter: ProjectListFilter,
    page: NormalizedPageQuery,
  ): Promise<PageResult<ProjectListItem>> {
    const sortBy = assertSortField(
      normalizeSortBy(page.sortBy),
      PROJECT_SORT_KEYS,
      'updatedAt',
    );
    const { aggregates, rows, total } = await this.repo.findPaged(
      toActorScope(actor),
      filter,
      { ...page, sortBy },
    );
    return {
      items: rows.map((row) =>
        toListItem(row, aggregates.get(row.id.toString()) ?? createEmptyAggregates()),
      ),
      total,
    };
  }

  /** §4.1.4 详情：`prototypeCount` 在详情里是明细对象（列表里是数字）。 */
  async detail(actor: Actor, id: string): Promise<ProjectDetail> {
    const row = await this.repo.findAccessible(parseIdParam(id, '项目 id'), toActorScope(actor));
    return this.buildDetail(row);
  }

  /** §4.1.3 创建：code 留空走服务端生成，并把创建人写成 owner（§6.2 一期成员数据的唯一来源）。 */
  async create(
    actor: Actor,
    input: CreateProjectInput,
    request: RequestMeta,
  ): Promise<ProjectDetail> {
    const userId = BigInt(actor.userId);
    const code = input.code?.trim() ?? '';
    const projectId =
      code === ''
        ? await this.createWithGeneratedCode(input, userId)
        : await this.createWithGivenCode(code, input, userId);

    await this.repo.addMember({
      createdBy: userId,
      memberRole: 'owner',
      projectId,
      userId,
    });
    await this.audit.record({
      actor,
      action: 'create',
      detail: { code: code === '' ? null : code, name: input.name },
      module: 'proto:project',
      request,
      resourceId: projectId.toString(),
      resourceName: input.name,
      resourceType: 'project',
    });

    const row = await this.repo.findAccessible(projectId, toActorScope(actor));
    return this.buildDetail(row);
  }

  /** §4.1.5 编辑：只改 name/description；code 传了忽略并回警告（不报错，老表单不至于提交失败）。 */
  async update(
    actor: Actor,
    id: string,
    input: UpdateProjectInput,
    request: RequestMeta,
  ): Promise<ProjectUpdateResult> {
    const scope = toActorScope(actor);
    const before = await this.repo.findAccessible(parseIdParam(id, '项目 id'), scope);
    await this.repo.update({
      description: input.description ?? null,
      id: before.id,
      name: input.name,
      updatedBy: BigInt(actor.userId),
    });
    await this.audit.record({
      actor,
      action: 'update',
      detail: buildChangeDiff(
        { description: before.description, name: before.name },
        { description: input.description ?? null, name: input.name },
      ),
      module: 'proto:project',
      request,
      resourceId: before.id.toString(),
      resourceName: input.name,
      resourceType: 'project',
    });
    const refreshed = await this.repo.findAccessible(before.id, scope);
    return {
      ...(await this.buildDetail(refreshed)),
      warnings: input.code === undefined ? [] : [ERROR_CODES.PROTO_CODE_IMMUTABLE],
    };
  }

  /** §4.1.6 软删除并级联其下原型（产物目录 7 天 GC 属 M3——那时才有产物）。 */
  async remove(actor: Actor, id: string, request: RequestMeta): Promise<void> {
    const row = await this.repo.findAccessible(parseIdParam(id, '项目 id'), toActorScope(actor));
    await this.repo.softDelete(row.id, BigInt(actor.userId));
    await this.audit.record({
      actor,
      action: 'delete',
      detail: { code: row.code, name: row.name },
      module: 'proto:project',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'project',
    });
  }

  /** §4.1.7/§4.1.8 归档与恢复。影响面（"其下所有原型链接不可访问"）由前端确认框承担。 */
  async setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
    request: RequestMeta,
  ): Promise<ProjectDetail> {
    const scope = toActorScope(actor);
    const row = await this.repo.findAccessible(parseIdParam(id, '项目 id'), scope);
    await this.repo.setArchived(row.id, archived ? new Date() : null, BigInt(actor.userId));
    await this.audit.record({
      actor,
      action: archived ? 'archive' : 'unarchive',
      detail: { archived, code: row.code },
      module: 'proto:project',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'project',
    });
    const refreshed = await this.repo.findAccessible(row.id, scope);
    return this.buildDetail(refreshed);
  }

  /** §4.1.9 成员列表。一期只展示与记录 member_role，不据此做差异授权（§6.2）。 */
  async members(actor: Actor, id: string): Promise<ProjectMemberItem[]> {
    const row = await this.repo.findAccessible(parseIdParam(id, '项目 id'), toActorScope(actor));
    const rows = await this.repo.members(row.id);
    return rows.map((entry) => ({
      createdAt: entry.createdAt.toISOString(),
      memberRole: toMemberRole(entry.memberRole),
      realName: entry.user.realName || entry.user.username,
      userId: entry.user.id.toString(),
      username: entry.user.username,
    }));
  }

  /** §4.1.10 覆盖式设置成员：创建人的 owner 不会被覆盖掉（否则项目会立刻从 owner 的列表里消失）。 */
  async setMembers(
    actor: Actor,
    id: string,
    input: SetProjectMembersInput,
    request: RequestMeta,
  ): Promise<ProjectMemberItem[]> {
    const scope = toActorScope(actor);
    const row = await this.repo.findAccessible(parseIdParam(id, '项目 id'), scope);
    const ownerUserId = row.createdBy;
    // owner 由 created_by 决定，不接受请求改写：请求里带上创建人却不给 memberRole 时默认成 viewer，
    // 覆盖式写入会把创建人降级——一期 member_role 虽不做差异授权，但"谁建的"是事实，不能被打掉。
    const targets = (await this.resolveMembers(input.members)).map((target) =>
      target.userId === ownerUserId ? { ...target, memberRole: 'owner' } : target,
    );
    if (!targets.some((target) => target.userId === ownerUserId)) {
      targets.unshift({ memberRole: 'owner', userId: ownerUserId });
    }
    const before = await this.repo.members(row.id);
    await this.repo.removeMembersNotIn(row.id, targets.map((target) => target.userId));
    for (const target of targets) {
      await this.repo.addMember({
        createdBy: BigInt(actor.userId),
        memberRole: target.memberRole,
        projectId: row.id,
        userId: target.userId,
      });
    }
    await this.audit.record({
      actor,
      action: 'set_member',
      detail: {
        after: targets.map((target) => target.userId.toString()),
        before: before.map((entry) => entry.userId.toString()),
      },
      module: 'proto:project',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'project',
    });
    return this.members(actor, id);
  }

  /** §4.2 编码可用性：留空合法（回一个候选生成值），非法/占用都带可读原因与备选。 */
  async checkCode(code?: string): Promise<CodeCheckResult> {
    const value = code?.trim() ?? '';
    if (value === '') {
      return { available: true, generated: genProjectCode() };
    }
    const format = validateProjectCode(value);
    if (!format.valid) {
      return {
        available: false,
        message: projectCodeMessage(value, format.reason),
        reason: invalidCodeReason(format.reason),
      };
    }
    const taken = await this.repo.findActiveByCode(value);
    if (taken) {
      return {
        available: false,
        message: `该编码已被项目「${taken.name}」占用`,
        reason: 'CODE_TAKEN',
        suggestion: await this.suggestCode(value),
      };
    }
    return { available: true };
  }

  private async buildDetail(row: ProjectRow): Promise<ProjectDetail> {
    const aggregates =
      (await this.repo.aggregatesFor([row.id])).get(row.id.toString()) ??
      createEmptyAggregates();
    const base = toListItem(row, aggregates);
    return {
      ...base,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      memberCount: await this.repo.memberCount(row.id),
      prototypeCount: {
        archived: aggregates.archived,
        draft: aggregates.draft,
        published: aggregates.published,
        total: aggregates.total,
      },
    };
  }

  /**
   * 留空生成（D-20）：`p-` + 8 位 base36，撞唯一索引就重试，最多 CODE_AUTOGEN_MAX_RETRY 次。
   * 用重试而不是预检查：随机码的占用窗口只有唯一索引能兜住，预检查在两次请求之间照样会被插队。
   */
  private async createWithGeneratedCode(
    input: CreateProjectInput,
    userId: bigint,
  ): Promise<bigint> {
    for (let attempt = 1; attempt <= CODE_AUTOGEN_MAX_RETRY; attempt += 1) {
      try {
        return await this.repo.create({
          code: genProjectCode(),
          createdBy: userId,
          description: input.description ?? null,
          name: input.name,
        });
      } catch (error: unknown) {
        if (!this.repo.isCodeConflict(error)) {
          throw error;
        }
      }
    }
    throw projectCodeExhaustedError();
  }

  /**
   * 手填编码：先判规则（400 PROTO_CODE_INVALID），再判占用（400 + 人名，Gate G3 要的就是这句），
   * 最后唯一索引命中说明是并发抢码（§1.4 的 409）。
   */
  private async createWithGivenCode(
    code: string,
    input: CreateProjectInput,
    userId: bigint,
  ): Promise<bigint> {
    assertProjectCodeFormat(code);
    const taken = await this.repo.findActiveByCode(code);
    if (taken) {
      throw projectCodeTakenError(taken.name);
    }
    try {
      return await this.repo.create({
        code,
        createdBy: userId,
        description: input.description ?? null,
        name: input.name,
      });
    } catch (error: unknown) {
      if (this.repo.isCodeConflict(error)) {
        throw projectCodeRaceError();
      }
      throw error;
    }
  }

  /** 备选编码：`{code}-2`、`{code}-3`… 取第一个没被占用的（最多试 20 个，超长度上限就放弃）。 */
  private async suggestCode(value: string): Promise<string | undefined> {
    for (let suffix = 2; suffix <= 21; suffix += 1) {
      const candidate = `${value}-${String(suffix)}`;
      if (candidate.length > 63) {
        return undefined;
      }
      if (!(await this.repo.findActiveByCode(candidate))) {
        return candidate;
      }
    }
    return undefined;
  }

  /** 成员必须真实存在且未删除；把外键错误翻译成人话，而不是让 500 冒出来。 */
  private async resolveMembers(
    members: readonly ProjectMemberInput[],
  ): Promise<{ memberRole: string; userId: bigint }[]> {
    if (members.length === 0) {
      return [];
    }
    const wanted = members.map((member) => parseIdParam(member.userId, '成员 user id'));
    const existing = await this.repo.existingUserIds(wanted);
    const missing = members
      .map((member) => member.userId)
      .filter((userId) => !existing.has(userId));
    if (missing.length > 0) {
      throw new BusinessException(
        `这些用户不存在或已被删除：${missing.join('、')}`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    return members.map((member) => ({
      memberRole: member.memberRole ?? 'viewer',
      userId: BigInt(member.userId),
    }));
  }
}

/** 派生状态（D-22）：归档优先，其次看有没有已发布原型，其余算草稿。 */
export function deriveProjectStatus(
  archivedAt: Date | null,
  aggregates: ProjectAggregates,
): ProjectStatus {
  if (archivedAt !== null) {
    return 'archived';
  }
  return aggregates.published > 0 ? 'published' : 'draft';
}

function toListItem(row: ProjectRow, aggregates: ProjectAggregates): ProjectListItem {
  return {
    code: row.code,
    createdByName: row.createdByName ?? '',
    description: row.description,
    id: row.id.toString(),
    lastPublishedAt: aggregates.lastPublishedAt?.toISOString() ?? null,
    name: row.name,
    prototypeCount: aggregates.total,
    publishedCount: aggregates.published,
    status: deriveProjectStatus(row.archivedAt, aggregates),
    updatedAt: row.updatedAt.toISOString(),
    visitsLast7d: aggregates.visitsLast7d,
  };
}

function toMemberRole(value: string): MemberRole {
  return value === 'owner' || value === 'editor' ? value : 'viewer';
}

/** check-code 的 reason 只有 §4.2 的三个取值；超长与格式错同档（前端都在字段下显示同一句）。 */
function invalidCodeReason(reason: CodeInvalidReason | null): CodeCheckReason {
  return reason === 'RESERVED' ? 'CODE_RESERVED' : 'CODE_FORMAT_INVALID';
}

import { Injectable } from '@nestjs/common';
import { argon2id, hash } from 'argon2';
import {
  ERROR_CODES,
  nextGeneratedPrototypeCode,
  validatePrototypeCode,
  type CodeCheckResult,
  type PageResult,
  type PrototypeDetail,
  type PrototypeListItem,
  type PrototypeUpdateResult,
  type PrototypeStatus,
} from '@protohub/shared';

import { toActorScope } from '../../common/data-scope';
import { BusinessException } from '../../common/exception/business.exception';
import type { NormalizedPageQuery } from '../../common/pagination/pagination';
import {
  ACCESS_PASSWORD_MIN_LENGTH,
  CODE_AUTOGEN_MAX_RETRY,
} from '../../config/constants';
import {
  assertPrototypeCodeFormat,
  prototypeCodeExhaustedError,
  prototypeCodeMessage,
  prototypeCodeRaceError,
  prototypeCodeTakenError,
} from '../../common/code-feedback';
import { accessUrlOf, prototypeAccessPath } from '../../common/access-path';
import { AppEnvService } from '../../config/app-env.service';
import type { Actor, RequestMeta } from '../system/common/actor';
import {
  buildChangeDiff,
  passwordChangedDetail,
} from '../system/common/audit-diff';
import { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import { assertSortField, parseIdParam } from '../system/common/dto';
import { ProjectRepo } from '../project/project.repo';
import {
  createEmptyPrototypeAggregates,
  PROTOTYPE_AGGREGATE_SORTS,
  PROTOTYPE_SCALAR_SORTS,
  PrototypeRepo,
  type PrototypeAggregates,
  type PrototypeListFilter,
  type PrototypeRow,
} from './prototype.repo';
import type {
  CreatePrototypeInput,
  SetPrototypePolicyInput,
  UpdatePrototypeInput,
} from './prototype.dto';

const PROTOTYPE_SORT_KEYS = [
  ...PROTOTYPE_SCALAR_SORTS,
  ...PROTOTYPE_AGGREGATE_SORTS,
];

/** 列表默认按项目内展示顺序升序（`sort` 这一列存在的意义）；其余字段沿用"新的在前"。 */
function defaultSortOrder(sortBy: string): 'asc' | 'desc' {
  return sortBy === 'sort' ? 'asc' : 'desc';
}

/**
 * 原型（后端接口设计 §4.3/§4.4 + 决策 D-07/D-20/D-21）。
 *
 * 三条贯穿全类的规则：
 * 1. **可见性一律问父项目**（权限模型 §6.2）：列表先确认项目可达，单条走 `PrototypeRepo.findAccessible`；
 *    原型层不再写一遍 if，也就不会出现"项目能看见、原型判不准"的第二套真相。
 * 2. **`status` 落库**（D-22 只对项目派生）：归档写 `archived`，访问决策读的就是这一列。
 * 3. **策略是原型级**（D-21）：改模式/改密码才 `policy_version + 1`，同一项目下别的原型不受影响。
 */
@Injectable()
export class PrototypeService {
  constructor(
    private readonly repo: PrototypeRepo,
    private readonly projects: ProjectRepo,
    private readonly audit: OperationAuditWriter,
    private readonly appEnv: AppEnvService,
  ) {}

  /** §4.3.1 列表：projectId 必填，且项目本身要先在请求者范围内。 */
  async list(
    actor: Actor,
    filter: { keyword?: string; projectId: string; status?: PrototypeStatus },
    page: NormalizedPageQuery,
  ): Promise<PageResult<PrototypeListItem>> {
    const scope = toActorScope(actor);
    const projectId = parseIdParam(filter.projectId, '项目 id');
    await this.projects.findAccessible(projectId, scope);
    const sortBy = assertSortField(page.sortBy, PROTOTYPE_SORT_KEYS, 'sort');
    const repoFilter: PrototypeListFilter = {
      ...(filter.keyword === undefined ? {} : { keyword: filter.keyword }),
      projectId,
      ...(filter.status === undefined ? {} : { status: filter.status }),
    };
    const { aggregates, rows, total } = await this.repo.findPaged(scope, repoFilter, {
      ...page,
      sortBy,
      sortOrder: page.sortOrder ?? defaultSortOrder(sortBy),
    });
    const baseUrl = this.baseUrl();
    return {
      items: rows.map(
        (row) =>
          toListItem(
            row,
            aggregates.get(row.id.toString()) ?? createEmptyPrototypeAggregates(),
            baseUrl,
          ),
      ),
      total,
    };
  }

  /** §4.3.4 详情：访问地址、策略字段、当前版本摘要、可访问成员（= 父项目成员）。 */
  async detail(actor: Actor, id: string): Promise<PrototypeDetail> {
    const scope = toActorScope(actor);
    const row = await this.repo.findAccessible(parseIdParam(id, '原型 id'), scope);
    return this.buildDetail(row);
  }

  /** §4.3.3 新建草稿原型（不带文件；首次上传发布会走 M3 的自动建原型分支）。 */
  async create(
    actor: Actor,
    input: CreatePrototypeInput,
    request: RequestMeta,
  ): Promise<PrototypeDetail> {
    const scope = toActorScope(actor);
    const project = await this.projects.findAccessible(
      parseIdParam(input.projectId, '项目 id'),
      scope,
    );
    const userId = BigInt(actor.userId);
    const code = input.code?.trim() ?? '';
    const prototypeId =
      code === ''
        ? await this.createWithGeneratedCode(project.id, project.code, input, userId)
        : await this.createWithGivenCode(project.id, project.code, code, input, userId);

    await this.audit.record({
      actor,
      action: 'create',
      detail: { code: code === '' ? null : code, name: input.name, projectId: project.id.toString() },
      module: 'proto:prototype',
      request,
      resourceId: prototypeId.toString(),
      resourceName: input.name,
      resourceType: 'prototype',
    });
    const row = await this.repo.findAccessible(prototypeId, scope);
    return this.buildDetail(row);
  }

  /** §4.3.5 编辑：`name`/`description`/`sort`；`code` 传了忽略并回警告。 */
  async update(
    actor: Actor,
    id: string,
    input: UpdatePrototypeInput,
    request: RequestMeta,
  ): Promise<PrototypeUpdateResult> {
    const scope = toActorScope(actor);
    const before = await this.repo.findAccessible(parseIdParam(id, '原型 id'), scope);
    const sort = input.sort ?? before.sort;
    await this.repo.update({
      description: input.description ?? null,
      id: before.id,
      name: input.name,
      sort,
      updatedBy: BigInt(actor.userId),
    });
    await this.audit.record({
      actor,
      action: 'update',
      detail: buildChangeDiff(
        { description: before.description, name: before.name, sort: before.sort },
        { description: input.description ?? null, name: input.name, sort },
      ),
      module: 'proto:prototype',
      request,
      resourceId: before.id.toString(),
      resourceName: input.name,
      resourceType: 'prototype',
    });
    const refreshed = await this.repo.findAccessible(before.id, scope);
    return {
      ...(await this.buildDetail(refreshed)),
      warnings: input.code === undefined ? [] : [ERROR_CODES.PROTO_CODE_IMMUTABLE],
    };
  }

  /** §4.3.6 软删除（产物目录 7 天 GC 属 M3/M5——那时才有产物）。 */
  async remove(actor: Actor, id: string, request: RequestMeta): Promise<void> {
    const row = await this.repo.findAccessible(parseIdParam(id, '原型 id'), toActorScope(actor));
    await this.repo.softDelete(row.id, BigInt(actor.userId));
    await this.audit.record({
      actor,
      action: 'delete',
      detail: { code: row.code, name: row.name, projectId: row.projectId.toString() },
      module: 'proto:prototype',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'prototype',
    });
  }

  /** §4.3.7/§4.3.8 归档与恢复。影响面（"仅该原型链接不可访问"）由前端确认框承担。 */
  async setArchived(
    actor: Actor,
    id: string,
    archived: boolean,
    request: RequestMeta,
  ): Promise<PrototypeDetail> {
    const scope = toActorScope(actor);
    const row = await this.repo.findAccessible(parseIdParam(id, '原型 id'), scope);
    await this.repo.setStatus(
      row.id,
      archived ? 'archived' : restoreStatus(row),
      archived ? new Date() : null,
      BigInt(actor.userId),
    );
    await this.audit.record({
      actor,
      action: archived ? 'archive' : 'unarchive',
      detail: { archived, code: row.code },
      module: 'proto:prototype',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'prototype',
    });
    const refreshed = await this.repo.findAccessible(row.id, scope);
    return this.buildDetail(refreshed);
  }

  /**
   * §4.4 改访问策略。三个要点：
   * - 密码只在"本次真的给了新密码"时重写；`password` 省略表示沿用旧密码（§4.4 明文规定）。
   * - `policy_version + 1` 只在模式变了或换了密码时发生（D-07：旧解锁 Cookie 立即失效）。
   * - 审计 detail 走 `passwordChangedDetail()`，绝不出现密码本身（数据库设计 §4.1.9）。
   */
  async setPolicy(
    actor: Actor,
    id: string,
    input: SetPrototypePolicyInput,
    request: RequestMeta,
  ): Promise<PrototypeDetail> {
    const scope = toActorScope(actor);
    const row = await this.repo.findAccessible(parseIdParam(id, '原型 id'), scope);
    const password = input.password?.trim() ?? '';

    if (password !== '' && password.length < ACCESS_PASSWORD_MIN_LENGTH) {
      throw new BusinessException(
        `访问密码至少 ${String(ACCESS_PASSWORD_MIN_LENGTH)} 位`,
        ERROR_CODES.PROTO_POLICY_PASSWORD_INVALID,
        400,
      );
    }
    const passwordChanged = password !== '';
    if (input.accessMode === 'password' && !passwordChanged && !row.hasAccessPassword) {
      throw new BusinessException(
        `该原型还没有访问密码，请设置一个（至少 ${String(ACCESS_PASSWORD_MIN_LENGTH)} 位）`,
        ERROR_CODES.PROTO_POLICY_PASSWORD_REQUIRED,
        400,
      );
    }

    const modeChanged = row.accessMode !== input.accessMode;
    if (modeChanged || passwordChanged) {
      await this.repo.setPolicy({
        accessMode: input.accessMode,
        id: row.id,
        ...(passwordChanged
          ? { passwordHash: await hash(password, { type: argon2id }) }
          : {}),
        policyVersion: row.policyVersion + 1,
        updatedBy: BigInt(actor.userId),
      });
    }

    const detail = {
      ...buildChangeDiff(
        { accessMode: row.accessMode },
        { accessMode: input.accessMode },
      ),
      ...(passwordChanged ? passwordChangedDetail() : {}),
    };
    await this.audit.record({
      actor,
      action: 'policy',
      detail,
      module: 'proto:prototype',
      request,
      resourceId: row.id.toString(),
      resourceName: row.name,
      resourceType: 'prototype',
    });
    const refreshed = await this.repo.findAccessible(row.id, scope);
    return this.buildDetail(refreshed);
  }

  /** §4.3.2 编码可用性（项目内唯一，跨项目可重名）。留空合法，回"留空将生成这个"。 */
  async checkCode(
    actor: Actor,
    projectId: string,
    code?: string,
  ): Promise<CodeCheckResult> {
    const scope = toActorScope(actor);
    const id = parseIdParam(projectId, '项目 id');
    const project = await this.projects.findAccessible(id, scope);
    const value = code?.trim() ?? '';
    if (value === '') {
      const codes = await this.repo.activeCodesInProject(id);
      return {
        available: true,
        generated: nextGeneratedPrototypeCode(project.code, codes),
      };
    }
    const format = validatePrototypeCode(value);
    if (!format.valid) {
      return {
        available: false,
        message: prototypeCodeMessage(value, format.reason),
        reason: 'CODE_FORMAT_INVALID',
      };
    }
    const taken = await this.repo.findActiveByCode(id, value);
    if (taken) {
      return {
        available: false,
        message: `编码「${value}」已被原型「${taken.name}」占用，请换一个`,
        reason: 'CODE_TAKEN',
        suggestion: await this.suggestCode(id, value),
      };
    }
    return { available: true };
  }

  /** 备选编码：`{code}-2`、`{code}-3`… 取第一个在项目内没被占用的。 */
  private async suggestCode(
    projectId: bigint,
    value: string,
  ): Promise<string | undefined> {
    for (let suffix = 2; suffix <= 21; suffix += 1) {
      const candidate = `${value}-${String(suffix)}`;
      if (candidate.length > 63 || !validatePrototypeCode(candidate).valid) {
        return undefined;
      }
      if (!(await this.repo.findActiveByCode(projectId, candidate))) {
        return candidate;
      }
    }
    return undefined;
  }

  private async buildDetail(row: PrototypeRow): Promise<PrototypeDetail> {
    const aggregates =
      (await this.repo.aggregatesFor([row])).get(row.id.toString()) ??
      createEmptyPrototypeAggregates();
    const members = await this.projects.members(row.projectId);
    return {
      ...toListItem(row, aggregates, this.baseUrl()),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      currentReleaseId: row.currentReleaseId?.toString() ?? null,
      firstPublishedAt: row.firstPublishedAt?.toISOString() ?? null,
      hasAccessPassword: row.hasAccessPassword,
      memberIds: members.map((member) => member.user.id.toString()),
      policyVersion: row.policyVersion,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    };
  }

  /** 访问地址的域名部分只从这里取（§4.3：不要让每个前端页面各拼一遍）。 */
  private baseUrl(): string {
    return this.appEnv.env.http.publicBaseUrl;
  }


  /**
   * 留空生成（D-20）：`{项目码}-pNN`，序号取项目内已有生成码的最大值 + 1（跨越 99 自然进位三位）。
   * 每次重试都重新读一遍在用编码：唯一索引 `uk_proto_prototype_code` 只兜并发，取号本身要基于最新快照。
   */
  private async createWithGeneratedCode(
    projectId: bigint,
    projectCode: string,
    input: CreatePrototypeInput,
    userId: bigint,
  ): Promise<bigint> {
    for (let attempt = 1; attempt <= CODE_AUTOGEN_MAX_RETRY; attempt += 1) {
      const codes = await this.repo.activeCodesInProject(projectId);
      try {
        return await this.repo.create({
          code: nextGeneratedPrototypeCode(projectCode, codes),
          createdBy: userId,
          description: input.description ?? null,
          name: input.name,
          projectId,
        });
      } catch (error: unknown) {
        if (!this.repo.isCodeConflict(error)) {
          throw error;
        }
      }
    }
    throw prototypeCodeExhaustedError();
  }

  /** 手填编码：格式（400）→ 项目内占用（400，带上占用者名字）→ 并发抢码（409）。 */
  private async createWithGivenCode(
    projectId: bigint,
    projectCode: string,
    code: string,
    input: CreatePrototypeInput,
    userId: bigint,
  ): Promise<bigint> {
    assertPrototypeCodeFormat(code);
    const taken = await this.repo.findActiveByCode(projectId, code);
    if (taken) {
      throw prototypeCodeTakenError(projectCode, code, taken.name);
    }
    try {
      return await this.repo.create({
        code,
        createdBy: userId,
        description: input.description ?? null,
        name: input.name,
        projectId,
      });
    } catch (error: unknown) {
      if (this.repo.isCodeConflict(error)) {
        throw prototypeCodeRaceError();
      }
      throw error;
    }
  }
}

/**
 * 恢复上架后的状态：归档前是"已发布"还是"草稿"没有第二处存储，按有没有生效版本重新推导
 * （与 D-22 同一思路——不为一次性信息多开一列真相）。
 */
function restoreStatus(row: PrototypeRow): PrototypeStatus {
  return row.currentReleaseId === null ? 'draft' : 'published';
}

function toListItem(
  row: PrototypeRow,
  aggregates: PrototypeAggregates,
  baseUrl: string,
): PrototypeListItem {
  const path = prototypeAccessPath(row.projectCode, row.code);
  return {
    accessMode: row.accessMode,
    accessPath: path,
    accessUrl: accessUrlOf(baseUrl, path),
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    currentRelease: aggregates.currentRelease,
    description: row.description,
    id: row.id.toString(),
    name: row.name,
    projectId: row.projectId.toString(),
    releaseCount: aggregates.releaseCount,
    sort: row.sort,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    visitsLast7d: aggregates.visitsLast7d,
  };
}

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ERROR_CODES, type ProjectStatus, type StatusStats } from '@protohub/shared';

import {
  andProjectScope,
  type ActorScope,
} from '../../common/data-scope';
import { ForbiddenBusinessException } from '../../common/exception/business.exception';
import { entryVisitsByPrototype } from '../../common/entry-visits';
import type { NormalizedPageQuery } from '../../common/pagination/pagination';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 项目查询层（权限模型设计 §6.2 + 计划 M2-T2）。
 *
 * 这里是数据范围**唯一**落地的地方：`findPaged` 组列表条件、`findAccessible` 组单条条件，
 * 两者共用 `andProjectScope`。服务层不允许再自己拼 `createdBy`，否则就会出现
 * "列表看不到别人的项目、但猜到 id 就能打开详情"（计划 §8 F-5）。
 */

/** 派生状态（D-22）由这三项聚合出，所以聚合值必须和状态筛选口径一致：都只看未软删的原型。 */
export interface ProjectAggregates {
  archived: number;
  draft: number;
  lastPublishedAt: Date | null;
  published: number;
  total: number;
  visitsLast7d: number;
}

export interface ProjectRow {
  archivedAt: Date | null;
  code: string;
  createdAt: Date;
  createdBy: bigint;
  createdByName: string | null;
  description: string | null;
  id: bigint;
  name: string;
  updatedAt: Date;
}

export interface ProjectListFilter {
  readonly keyword?: string;
  readonly status?: ProjectStatus;
}

/** 空聚合：项目还没有任何原型时用（不要让调用方到处判 undefined）。 */
const EMPTY_AGGREGATES: ProjectAggregates = {
  archived: 0,
  draft: 0,
  lastPublishedAt: null,
  published: 0,
  total: 0,
  visitsLast7d: 0,
};

/** 新建一份空聚合（返回副本而不是共享常量：调用方会就地累加）。 */
export function createEmptyAggregates(): ProjectAggregates {
  return { ...EMPTY_AGGREGATES };
}

/**
 * 可排序字段（§4.1.1 只写了"支持 sortBy"，具体取值按列表列定）。
 * 分成标量列与聚合列两组：前者交给数据库排序＋分页，后者必须先聚合才能排，见 `findPaged`。
 */
export const PROJECT_SCALAR_SORTS = ['code', 'createdAt', 'name', 'updatedAt'] as const;
export const PROJECT_AGGREGATE_SORTS = [
  'lastPublishedAt',
  'prototypeCount',
  'publishedCount',
  'visitsLast7d',
] as const;
export const PROJECT_SORT_FIELDS = [
  ...PROJECT_SCALAR_SORTS,
  ...PROJECT_AGGREGATE_SORTS,
] as const;

const CREATOR_SELECT = {
  createdByUser: { select: { realName: true, username: true } },
} satisfies Prisma.ProtoProjectInclude;

function toRow(entity: Prisma.ProtoProjectGetPayload<{ include: typeof CREATOR_SELECT }>): ProjectRow {
  const creator = entity.createdByUser;
  return {
    archivedAt: entity.archivedAt,
    code: entity.code,
    createdAt: entity.createdAt,
    createdBy: entity.createdBy,
    createdByName: creator ? (creator.realName || creator.username) : null,
    description: entity.description,
    id: entity.id,
    name: entity.name,
    updatedAt: entity.updatedAt,
  };
}

/**
 * 派生状态 → 查询条件（D-22 不落库，所以筛选必须翻译成原型聚合的条件）。
 * `draft` 用 `none`：一个原型都没有的项目同样是草稿，这与界面显示一致。
 */
function statusWhere(status: ProjectStatus): Prisma.ProtoProjectWhereInput {
  if (status === 'archived') {
    return { archivedAt: { not: null } };
  }
  const publishedPrototype = { deletedAt: null, status: 'published' } satisfies Prisma.ProtoPrototypeWhereInput;
  return status === 'published'
    ? { archivedAt: null, prototypes: { some: publishedPrototype } }
    : { archivedAt: null, prototypes: { none: publishedPrototype } };
}

@Injectable()
export class ProjectRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /** §6.2：查不到就 403，且**不区分"不存在"与"无权"**——否则可以靠状态码探测别人的项目 id。 */
  async findAccessible(id: bigint, scope: ActorScope): Promise<ProjectRow> {
    const row = await this.db.protoProject.findFirst({
      include: CREATOR_SELECT,
      where: andProjectScope(scope, { deletedAt: null, id }),
    });
    if (!row) {
      throw new ForbiddenBusinessException(
        '项目不存在或你没有访问权限',
        ERROR_CODES.PROTO_NOT_ACCESSIBLE,
      );
    }
    return toRow(row);
  }

  /** 范围外的行同样查不到（写操作与读操作共用一条判定）。 */
  async findInScope(id: bigint, scope: ActorScope): Promise<ProjectRow | null> {
    const row = await this.db.protoProject.findFirst({
      include: CREATOR_SELECT,
      where: andProjectScope(scope, { deletedAt: null, id }),
    });
    return row ? toRow(row) : null;
  }

  /**
   * 列表（含 total）。返回的 rows 已按 page 切片，聚合值另走 `aggregatesFor`（同一批 id）。
   *
   * 聚合列排序必须先把**全部**命中行聚合出来才能排（SQL 层没有现成的 join 排序可用），
   * 所以这条路比标量排序慢——接口设计 §4.1 已经预见到，并把它写成前端可接受的慢。
   */
  async findPaged(
    scope: ActorScope,
    filter: ProjectListFilter,
    page: NormalizedPageQuery,
  ): Promise<{ aggregates: Map<string, ProjectAggregates>; rows: ProjectRow[]; total: number }> {
    const where = this.listWhere(scope, filter);
    const sortBy = page.sortBy ?? 'updatedAt';

    if ((PROJECT_AGGREGATE_SORTS as readonly string[]).includes(sortBy)) {
      const all = await this.db.protoProject.findMany({ include: CREATOR_SELECT, orderBy: { id: 'asc' }, where });
      const aggregates = await this.aggregatesFor(all.map((row) => row.id));
      const sorted = all
        .map(toRow)
        .sort((left, right) => {
          const value = compareAggregate(
            sortBy,
            aggregates.get(left.id.toString()) ?? EMPTY_AGGREGATES,
            aggregates.get(right.id.toString()) ?? EMPTY_AGGREGATES,
          );
          return value === 0
            ? Number(left.id - right.id)
            : page.sortOrder === 'asc'
              ? value
              : -value;
        });
      return {
        aggregates,
        rows: sorted.slice(page.skip, page.skip + page.pageSize),
        total: sorted.length,
      };
    }

    const [rows, total] = await Promise.all([
      this.db.protoProject.findMany({
        include: CREATOR_SELECT,
        orderBy: scalarOrderBy(sortBy, page.sortOrder ?? 'desc'),
        skip: page.skip,
        take: page.pageSize,
        where,
      }),
      this.db.protoProject.count({ where }),
    ]);
    const ids = rows.map((row) => row.id);
    return {
      aggregates: await this.aggregatesFor(ids),
      rows: rows.map(toRow),
      total,
    };
  }

  /**
   * 原型计数 / 最近发布时间 / 近 7 天入口访问，一次把这一页项目的聚合取齐。
   *
   * "近 7 天入口访问"= `proto_access_log` 里 result=ok 的行（原型发布与访问机制 §6：
   * 只有入口访问会写 ok 日志，资源请求不写），窗口见 VISITS_WINDOW_DAYS。
   */
  async aggregatesFor(projectIds: readonly bigint[]): Promise<Map<string, ProjectAggregates>> {
    const result = new Map<string, ProjectAggregates>();
    if (projectIds.length === 0) {
      return result;
    }
    for (const id of projectIds) {
      result.set(id.toString(), { ...EMPTY_AGGREGATES });
    }

    const prototypes = await this.db.protoPrototype.findMany({
      select: { id: true, projectId: true, publishedAt: true, status: true },
      where: { deletedAt: null, projectId: { in: [...projectIds] } },
    });
    const visitsByPrototype = await entryVisitsByPrototype(
      this.db,
      prototypes.map((prototype) => prototype.id),
    );

    for (const prototype of prototypes) {
      const key = prototype.projectId.toString();
      const current = result.get(key) ?? { ...EMPTY_AGGREGATES };
      current.total += 1;
      if (prototype.status === 'published') current.published += 1;
      else if (prototype.status === 'archived') current.archived += 1;
      else current.draft += 1;
      current.visitsLast7d += visitsByPrototype.get(prototype.id.toString()) ?? 0;
      if (prototype.publishedAt && (!current.lastPublishedAt || prototype.publishedAt > current.lastPublishedAt)) {
        current.lastPublishedAt = prototype.publishedAt;
      }
      result.set(key, current);
    }
    return result;
  }

  /**
   * 工作台 §3.1 的 `projectStats`。
   *
   * 三个数都走列表那一条 `listWhere`：同一份 `deletedAt: null`、同一份数据范围、同一个派生状态
   * 条件，所以"工作台说有几个项目"与"项目列表翻到底有几个"不可能是两件事（计划 M5-T1 的判据
   * 原文就是「数据与项目列表能对上」）。
   * 总数取三者相加而不是第四次 `count`：`statusWhere` 的三支（`archivedAt` 非空 / 为空且有已发布
   * 原型 / 为空且没有）互斥且穷尽，相加恒等于不带状态条件的总数。
   */
  async statusCounts(scope: ActorScope): Promise<StatusStats> {
    const [archived, draft, published] = await Promise.all([
      this.db.protoProject.count({ where: this.listWhere(scope, { status: 'archived' }) }),
      this.db.protoProject.count({ where: this.listWhere(scope, { status: 'draft' }) }),
      this.db.protoProject.count({ where: this.listWhere(scope, { status: 'published' }) }),
    ]);
    return { archived, draft, published, total: archived + draft + published };
  }

  /** 编码可用性判定要看**全库**在用项目（§4.2），与请求者的数据范围无关。 */
  async findActiveByCode(code: string): Promise<{ id: bigint; name: string } | null> {
    const row = await this.db.protoProject.findFirst({
      select: { id: true, name: true },
      where: { code, deletedAt: null },
    });
    return row ?? null;
  }

  /** 成员必须是真实存在且未删除的用户；否则写 proto_project_member 会撞外键变成 500。 */
  async existingUserIds(userIds: readonly bigint[]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set<string>();
    }
    const rows = await this.db.sysUser.findMany({
      select: { id: true },
      where: { deletedAt: null, id: { in: [...userIds] } },
    });
    return new Set(rows.map((row) => row.id.toString()));
  }

  async memberCount(projectId: bigint): Promise<number> {
    return this.db.protoProjectMember.count({ where: { projectId } });
  }

  async members(projectId: bigint): Promise<
    { createdAt: Date; memberRole: string; userId: bigint; user: { id: bigint; realName: string; username: string } }[]
  > {
    return this.db.protoProjectMember.findMany({
      include: { user: { select: { id: true, realName: true, username: true } } },
      orderBy: { createdAt: 'asc' },
      where: { projectId },
    });
  }

  async create(input: {
    code: string;
    createdBy: bigint;
    description: string | null;
    name: string;
  }): Promise<bigint> {
    return this.createOn(this.db, input);
  }

  /**
   * 受理事务用的插入（机制 §3.0 a）。`create()` 只是它的单连接版：
   * 行的形态只有一处定义，发布链路不必抄一份 data 对象（§3.7）。
   */
  async createOn(client: Prisma.TransactionClient, input: {
    code: string;
    createdBy: bigint;
    description: string | null;
    name: string;
  }): Promise<bigint> {
    const row = await client.protoProject.create({
      data: {
        code: input.code,
        createdBy: input.createdBy,
        description: input.description,
        name: input.name,
        updatedBy: input.createdBy,
      },
      select: { id: true },
    });
    return row.id;
  }

  async addMember(input: {
    createdBy: bigint;
    memberRole: string;
    projectId: bigint;
    userId: bigint;
  }): Promise<void> {
    await this.addMemberOn(this.db, input);
  }

  /** 同上：事务内加成员（新建项目时创建者必须是 owner，见 §6.2）。 */
  async addMemberOn(client: Prisma.TransactionClient, input: {
    createdBy: bigint;
    memberRole: string;
    projectId: bigint;
    userId: bigint;
  }): Promise<void> {
    await client.protoProjectMember.upsert({
      create: {
        createdBy: input.createdBy,
        memberRole: input.memberRole,
        projectId: input.projectId,
        userId: input.userId,
      },
      update: { memberRole: input.memberRole },
      where: {
        projectId_userId: { projectId: input.projectId, userId: input.userId },
      },
    });
  }

  async removeMembersNotIn(projectId: bigint, userIds: readonly bigint[]): Promise<void> {
    await this.db.protoProjectMember.deleteMany({
      where: { projectId, userId: { notIn: [...userIds] } },
    });
  }

  async update(input: {
    description: string | null;
    id: bigint;
    name: string;
    updatedBy: bigint;
  }): Promise<void> {
    await this.db.protoProject.update({
      data: {
        description: input.description,
        name: input.name,
        // schema 的 updated_at 只有 DEFAULT now()、没有 @updatedAt（数据库设计 §4.1.1），
        // 不显式写就不会前进；列表页的"最近更新"和默认排序依赖它。同 user.service。
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      },
      where: { id: input.id },
    });
  }

  /**
   * 归档/恢复只写 `archived_at`（项目层唯一状态字段，见数据库设计 §4.2.1）。
   * 链接是否可访问由访问决策读这个字段判定（M4），所以这里不需要动原型行。
   */
  async setArchived(id: bigint, archivedAt: Date | null, updatedBy: bigint): Promise<void> {
    await this.db.protoProject.update({
      data: { archivedAt, updatedAt: new Date(), updatedBy },
      where: { id },
    });
  }

  async softDelete(id: bigint, updatedBy: bigint): Promise<void> {
    const deletedAt = new Date();
    await this.db.$transaction([
      this.db.protoProject.update({
        data: { deletedAt, updatedAt: deletedAt, updatedBy },
        where: { id },
      }),
      // 级联软删其下原型：删掉的项目不该还能被单独访问到某个原型（F-6 的反向问题）。
      this.db.protoPrototype.updateMany({
        data: { deletedAt, updatedAt: deletedAt },
        where: { deletedAt: null, projectId: id },
      }),
    ]);
  }

  /** 唯一索引名出现在 P2002 里（uk_proto_project_code），服务层据此判断"是撞码而不是别的约束"。 */
  isCodeConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  private listWhere(scope: ActorScope, filter: ProjectListFilter): Prisma.ProtoProjectWhereInput {
    const base: Prisma.ProtoProjectWhereInput = { deletedAt: null };
    if (filter.status) {
      Object.assign(base, statusWhere(filter.status));
    }
    const keyword = filter.keyword?.trim();
    if (keyword) {
      base.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { code: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    return andProjectScope(scope, base);
  }
}

function scalarOrderBy(sortBy: string, sortOrder: 'asc' | 'desc'): Prisma.ProtoProjectOrderByWithRelationInput {
  switch (sortBy) {
    case 'code':
      return { code: sortOrder };
    case 'createdAt':
      return { createdAt: sortOrder };
    case 'name':
      return { name: sortOrder };
    default:
      return { updatedAt: sortOrder };
  }
}

function compareAggregate(
  sortBy: string,
  left: ProjectAggregates,
  right: ProjectAggregates,
): number {
  if (sortBy === 'visitsLast7d') {
    return left.visitsLast7d - right.visitsLast7d;
  }
  if (sortBy === 'prototypeCount') {
    return left.total - right.total;
  }
  if (sortBy === 'publishedCount') {
    return left.published - right.published;
  }
  return (left.lastPublishedAt?.getTime() ?? 0) - (right.lastPublishedAt?.getTime() ?? 0);
}

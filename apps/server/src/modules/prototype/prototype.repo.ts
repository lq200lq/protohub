import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ERROR_CODES,
  type AccessMode,
  type CurrentReleaseSummary,
  type PrototypeStatus,
  type StatusStats,
} from '@protohub/shared';

import { andPrototypeScope, type ActorScope } from '../../common/data-scope';
import { isUniqueViolation } from '../../common/db-error';
import { entryVisitsByPrototype } from '../../common/entry-visits';
import { ForbiddenBusinessException } from '../../common/exception/business.exception';
import type { NormalizedPageQuery } from '../../common/pagination/pagination';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 原型查询层（后端接口设计 §4.3 + 权限模型 §6.2）。
 *
 * 两条硬规则：
 * 1. **范围一律走 `andPrototypeScope`**（父项目条件嵌套），本层不写 `createdBy`；
 *    与 `ProjectRepo.findAccessible` 共用 `projectScopeWhere`，所以不会出现"列表看得见、详情 403"。
 * 2. **`password_hash` 不出这一层**：行对象里只有 `hasAccessPassword`，避免哈希顺着返回值溜到前端。
 */

export interface PrototypeRow {
  accessMode: AccessMode;
  archivedAt: null | Date;
  code: string;
  createdAt: Date;
  createdBy: bigint;
  currentReleaseId: null | bigint;
  description: null | string;
  firstPublishedAt: null | Date;
  hasAccessPassword: boolean;
  id: bigint;
  name: string;
  policyVersion: number;
  /** 访问路径第一段（§4.3 accessPath = /p/{projectCode}/{code}） */
  projectCode: string;
  projectId: bigint;
  publishedAt: null | Date;
  sort: number;
  status: PrototypeStatus;
  updatedAt: Date;
}

/** 列表/详情里的版本与访问聚合（M2 期间没有版本，恒为 0/null，但结构与 §4.3 一致）。 */
export interface PrototypeAggregates {
  currentRelease: CurrentReleaseSummary | null;
  releaseCount: number;
  visitsLast7d: number;
}

/** 工作台的一行原型：原型行 + 父项目名（§3.1 左栏"原型名 · 所属项目"）。 */
export interface RecentPrototypeRow extends PrototypeRow {
  readonly projectName: string;
}

export interface PrototypeListFilter {
  readonly keyword?: string;
  readonly projectId: bigint;
  readonly status?: PrototypeStatus;
}

const EMPTY_AGGREGATES: PrototypeAggregates = {
  currentRelease: null,
  releaseCount: 0,
  visitsLast7d: 0,
};

export function createEmptyPrototypeAggregates(): PrototypeAggregates {
  return { ...EMPTY_AGGREGATES };
}

/**
 * 可排序字段：`sort` 是项目内展示顺序（数据库 §4.2.2），列表默认按它升序；
 * `releaseCount`/`visitsLast7d` 是聚合值，见 `findPaged`。
 */
export const PROTOTYPE_SCALAR_SORTS = [
  'code',
  'createdAt',
  'name',
  'sort',
  'updatedAt',
] as const;
export const PROTOTYPE_AGGREGATE_SORTS = ['releaseCount', 'visitsLast7d'] as const;
export const PROTOTYPE_SORT_FIELDS = [
  ...PROTOTYPE_SCALAR_SORTS,
  ...PROTOTYPE_AGGREGATE_SORTS,
] as const;

const PROTOTYPE_SELECT = {
  accessMode: true,
  archivedAt: true,
  code: true,
  createdAt: true,
  createdBy: true,
  currentReleaseId: true,
  description: true,
  firstPublishedAt: true,
  id: true,
  name: true,
  passwordHash: true,
  policyVersion: true,
  project: { select: { code: true } },
  projectId: true,
  publishedAt: true,
  sort: true,
  status: true,
  updatedAt: true,
} satisfies Prisma.ProtoPrototypeSelect;

type PrototypeEntity = Prisma.ProtoPrototypeGetPayload<{ select: typeof PROTOTYPE_SELECT }>;

/**
 * 工作台「最近更新的原型」的取列（§3.1）：`PROTOTYPE_SELECT` 多一个父项目名。
 * 列表页在项目中看原型，项目名是冗余的；工作台跨项目，所以那一行必须自己说明属谁。
 */
const RECENT_SELECT = {
  ...PROTOTYPE_SELECT,
  project: { select: { code: true, name: true } },
} satisfies Prisma.ProtoPrototypeSelect;

/** DB 里 status/access_mode 是 varchar + CHECK；读进来时收敛成联合类型，越界值按最保守取值。 */
function toStatus(value: string): PrototypeStatus {
  return value === 'published' || value === 'archived' ? value : 'draft';
}

function toAccessMode(value: string): AccessMode {
  return value === 'password' || value === 'member' ? value : 'public';
}

function toRow(entity: PrototypeEntity): PrototypeRow {
  return {
    accessMode: toAccessMode(entity.accessMode),
    archivedAt: entity.archivedAt,
    code: entity.code,
    createdAt: entity.createdAt,
    createdBy: entity.createdBy,
    currentReleaseId: entity.currentReleaseId,
    description: entity.description,
    firstPublishedAt: entity.firstPublishedAt,
    hasAccessPassword: entity.passwordHash !== null,
    id: entity.id,
    name: entity.name,
    policyVersion: entity.policyVersion,
    projectCode: entity.project.code,
    projectId: entity.projectId,
    publishedAt: entity.publishedAt,
    sort: entity.sort,
    status: toStatus(entity.status),
    updatedAt: entity.updatedAt,
  };
}

@Injectable()
export class PrototypeRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /** §6.2：范围外与不存在都回同一个 403（不给出可探测 id 的状态差）。 */
  async findAccessible(id: bigint, scope: ActorScope): Promise<PrototypeRow> {
    const entity = await this.db.protoPrototype.findFirst({
      select: PROTOTYPE_SELECT,
      where: andPrototypeScope(scope, { deletedAt: null, id }),
    });
    if (!entity) {
      throw new ForbiddenBusinessException(
        '原型不存在或你没有访问权限',
        ERROR_CODES.PROTO_NOT_ACCESSIBLE,
      );
    }
    return toRow(entity);
  }

  /**
   * 列表。一次把该项目下命中的原型全取出来再切片：
   * `releaseCount` / `visitsLast7d` 是聚合值，排序无论如何要先全量聚合；
   * 单项目内的原型数量是界面可枚举的量级，两条代码路径不值得（也避免两种排序口径漂移）。
   */
  async findPaged(
    scope: ActorScope,
    filter: PrototypeListFilter,
    page: NormalizedPageQuery,
  ): Promise<{
    aggregates: Map<string, PrototypeAggregates>;
    rows: PrototypeRow[];
    total: number;
  }> {
    const entities = await this.db.protoPrototype.findMany({
      orderBy: { id: 'asc' },
      select: PROTOTYPE_SELECT,
      where: this.listWhere(scope, filter),
    });
    const rows = entities.map(toRow);
    const aggregates = await this.aggregatesFor(rows);
    const sortOrder = page.sortOrder ?? 'desc';
    const sortBy = page.sortBy ?? 'updatedAt';
    const sorted = [...rows].sort((left, right) => {
      const value = compareRows(
        sortBy,
        left,
        right,
        aggregates.get(left.id.toString()) ?? EMPTY_AGGREGATES,
        aggregates.get(right.id.toString()) ?? EMPTY_AGGREGATES,
      );
      return value === 0
        ? Number(left.id - right.id)
        : sortOrder === 'asc'
          ? value
          : -value;
    });
    return {
      aggregates,
      rows: sorted.slice(page.skip, page.skip + page.pageSize),
      total: sorted.length,
    };
  }

  /**
   * 版本数 / 当前生效版本 / 近 7 天入口访问，按**整页**一次取齐（不在 map 里逐行查库）。
   *
   * 访问量口径同 `ProjectRepo.aggregatesFor`：只有入口访问写 `result='ok'`
   * （原型发布与访问机制 §6），资源请求的 404 不算访问。
   */
  async aggregatesFor(
    rows: readonly PrototypeRow[],
  ): Promise<Map<string, PrototypeAggregates>> {
    const result = new Map<string, PrototypeAggregates>();
    if (rows.length === 0) {
      return result;
    }
    const prototypeIds = rows.map((row) => row.id);
    for (const row of rows) {
      result.set(row.id.toString(), { ...EMPTY_AGGREGATES });
    }

    const [releases, visitsByPrototype] = await Promise.all([
      this.db.protoRelease.findMany({
        select: {
          createdByUser: { select: { realName: true, username: true } },
          createdAt: true,
          fileCount: true,
          id: true,
          prototypeId: true,
          totalBytes: true,
          versionNo: true,
        },
        where: { deletedAt: null, prototypeId: { in: prototypeIds } },
      }),
      entryVisitsByPrototype(this.db, prototypeIds),
    ]);

    const releaseById = new Map(releases.map((release) => [release.id.toString(), release]));
    for (const release of releases) {
      const entry = result.get(release.prototypeId.toString()) ?? { ...EMPTY_AGGREGATES };
      entry.releaseCount += 1;
      result.set(release.prototypeId.toString(), entry);
    }
    for (const row of rows) {
      const visits = visitsByPrototype.get(row.id.toString());
      if (visits !== undefined) {
        const entry = result.get(row.id.toString()) ?? { ...EMPTY_AGGREGATES };
        entry.visitsLast7d = visits;
        result.set(row.id.toString(), entry);
      }
    }
    for (const row of rows) {
      if (row.currentReleaseId === null) {
        continue;
      }
      const release = releaseById.get(row.currentReleaseId.toString());
      if (!release) {
        continue;
      }
      const entry = result.get(row.id.toString()) ?? { ...EMPTY_AGGREGATES };
      entry.currentRelease = {
        fileCount: release.fileCount,
        id: release.id.toString(),
        publishedAt: (row.publishedAt ?? release.createdAt).toISOString(),
        publishedByName: release.createdByUser.realName || release.createdByUser.username,
        totalBytes: Number(release.totalBytes),
        versionNo: release.versionNo,
      };
      result.set(row.id.toString(), entry);
    }
    return result;
  }

  /**
   * 工作台 §3.1 的 `prototypeStats`：范围条件与列表同一条 `andPrototypeScope`（父项目判范围，
   * 权限模型 §6.2），`deletedAt: null` 与列表同一条。`total` 单独数而不是三个状态相加：
   * 状态列在库里有 CHECK 约束、相加理论上等于总数，但"约束以后被人放宽"这种漂移要表现为数字对不上，
   * 而不是被算术掩盖成看起来对。
   */
  async statusCounts(scope: ActorScope): Promise<StatusStats> {
    const count = (status?: PrototypeStatus) =>
      this.db.protoPrototype.count({ where: andPrototypeScope(scope, { deletedAt: null, status }) });
    const [archived, draft, published, total] = await Promise.all([
      count('archived'),
      count('draft'),
      count('published'),
      count(),
    ]);
    return { archived, draft, published, total };
  }

  /**
   * 工作台 §3.1 的 `recentPrototypes`：跨项目按原型自己的 `updatedAt` 倒序取 N 个。
   *
   * 判据点名"按原型取而不是按项目"，所以这里不经过项目聚合、也不按项目排；
   * 访问量交给调用方走 `aggregatesFor`（与列表页同一条取数路径，不为工作台另开一个口径）。
   */
  async recentUpdated(scope: ActorScope, limit: number): Promise<RecentPrototypeRow[]> {
    const entities = await this.db.protoPrototype.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: RECENT_SELECT,
      take: limit,
      where: andPrototypeScope(scope, { deletedAt: null }),
    });
    return entities.map((entity) => ({ ...toRow(entity), projectName: entity.project.name }));
  }

  /** 取号要看项目内**全部**在用原型码（含手填的），与请求者范围无关。 */
  async activeCodesInProject(projectId: bigint): Promise<string[]> {
    return this.activeCodesInProjectOn(this.db, projectId);
  }

  /** 受理事务里取序号要用同一个连接；查询条件与 §4.3.2 的自动编码判定同源（§3.7）。 */
  async activeCodesInProjectOn(
    client: Prisma.TransactionClient,
    projectId: bigint,
  ): Promise<string[]> {
    const rows = await client.protoPrototype.findMany({
      select: { code: true },
      where: { deletedAt: null, projectId },
    });
    return rows.map((row) => row.code);
  }

  /** 编码占用判定（§4.3.2 项目内唯一，跨项目可重名）。 */
  async findActiveByCode(
    projectId: bigint,
    code: string,
  ): Promise<{ id: bigint; name: string } | null> {
    const row = await this.db.protoPrototype.findFirst({
      select: { id: true, name: true },
      where: { code, deletedAt: null, projectId },
    });
    return row ?? null;
  }

  async create(input: {
    code: string;
    createdBy: bigint;
    description: string | null;
    name: string;
    projectId: bigint;
  }): Promise<bigint> {
    return this.createOn(this.db, input);
  }

  /**
   * 受理事务用的插入（机制 §3.0 b，`status` 走列默认值 `draft`）。
   * 与 §4.3.5 的新建原型共用同一份 data 形态，改列时不会只改一处。
   */
  async createOn(client: Prisma.TransactionClient, input: {
    code: string;
    createdBy: bigint;
    description: string | null;
    name: string;
    projectId: bigint;
  }): Promise<bigint> {
    const row = await client.protoPrototype.create({
      data: {
        code: input.code,
        createdBy: input.createdBy,
        description: input.description,
        name: input.name,
        projectId: input.projectId,
        updatedBy: input.createdBy,
      },
      select: { id: true },
    });
    return row.id;
  }

  async update(input: {
    description: string | null;
    id: bigint;
    name: string;
    sort: number;
    updatedBy: bigint;
  }): Promise<void> {
    await this.db.protoPrototype.update({
      data: {
        description: input.description,
        name: input.name,
        sort: input.sort,
        // updated_at 只有 DEFAULT now()、没有 @updatedAt，写不显式就不前进（同 ProjectRepo）。
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      },
      where: { id: input.id },
    });
  }

  /**
   * 归档写 `status='archived'`（访问决策读的是 status，见原型发布与访问机制 §5.3），
   * `archived_at` 同时落下作为时间留痕。
   */
  async setStatus(
    id: bigint,
    status: PrototypeStatus,
    archivedAt: Date | null,
    updatedBy: bigint,
  ): Promise<void> {
    await this.db.protoPrototype.update({
      data: { archivedAt, status, updatedAt: new Date(), updatedBy },
      where: { id },
    });
  }

  /**
   * 策略写入。`passwordHash` 只在本次真的设了密码时给值；沿用旧密码时不动它，
   * 这样 `ck_proto_prototype_pwd`（password 档必须有哈希）不会因为一次改模式而被破坏。
   */
  async setPolicy(input: {
    accessMode: AccessMode;
    id: bigint;
    passwordHash?: string;
    policyVersion: number;
    updatedBy: bigint;
  }): Promise<void> {
    await this.db.protoPrototype.update({
      data: {
        accessMode: input.accessMode,
        ...(input.passwordHash === undefined ? {} : { passwordHash: input.passwordHash }),
        policyVersion: input.policyVersion,
        updatedAt: new Date(),
        updatedBy: input.updatedBy,
      },
      where: { id: input.id },
    });
  }

  async softDelete(id: bigint, updatedBy: bigint): Promise<void> {
    const deletedAt = new Date();
    await this.db.protoPrototype.update({
      data: { deletedAt, updatedAt: deletedAt, updatedBy },
      where: { id },
    });
  }

  /**
   * 撞唯一索引（编码被抢）。判定本身在 `common/db-error.ts`：抢版本号（机制 §3.2）用的是
   * 同一个库信号，两处各写一遍 `code === 'P2002'` 早晚漂移（§3.7 收敛一处）。
   */
  isCodeConflict(error: unknown): boolean {
    return isUniqueViolation(error);
  }

  private listWhere(
    scope: ActorScope,
    filter: PrototypeListFilter,
  ): Prisma.ProtoPrototypeWhereInput {
    const base: Prisma.ProtoPrototypeWhereInput = {
      deletedAt: null,
      projectId: filter.projectId,
    };
    if (filter.status) {
      base.status = filter.status;
    }
    const keyword = filter.keyword?.trim();
    if (keyword) {
      base.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { code: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    return andPrototypeScope(scope, base);
  }
}

function compareRows(
  sortBy: string,
  left: PrototypeRow,
  right: PrototypeRow,
  leftAggregates: PrototypeAggregates,
  rightAggregates: PrototypeAggregates,
): number {
  switch (sortBy) {
    case 'code': {
      return left.code.localeCompare(right.code);
    }
    case 'createdAt': {
      return left.createdAt.getTime() - right.createdAt.getTime();
    }
    case 'name': {
      return left.name.localeCompare(right.name, 'zh-Hans-CN');
    }
    case 'releaseCount': {
      return leftAggregates.releaseCount - rightAggregates.releaseCount;
    }
    case 'visitsLast7d': {
      return leftAggregates.visitsLast7d - rightAggregates.visitsLast7d;
    }
    case 'sort': {
      // 同 sort 值（都是默认 0）时按创建时间倒序，避免顺序随 id 抖动
      return left.sort - right.sort || right.createdAt.getTime() - left.createdAt.getTime();
    }
    default: {
      return left.updatedAt.getTime() - right.updatedAt.getTime();
    }
  }
}

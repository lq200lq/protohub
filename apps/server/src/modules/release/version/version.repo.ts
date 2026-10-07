import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ERROR_CODES,
  RELEASE_EVENT_TYPES,
  RELEASE_STATUSES,
  type ReleaseEventType,
  type ReleaseStats,
  type ReleaseStatus,
  type UploadTaskWarning,
} from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import type { NormalizedPageQuery } from '../../../common/pagination/pagination';
import { PRISMA_CLIENT } from '../../system/persistence/prisma-token';
import { toWarnings } from '../warnings-codec';

/**
 * 版本与版本事件的读写（后端接口设计 §5.4–§5.8，外加 §3.1 工作台要的发布数与最近动态）。
 *
 * 分工与 §3.3 那条一致：**创建版本**只归 `pipeline/commit.ts`（它按机制 §3.1 的顺序写 release +
 * 切指针 + 写 publish 事件），本层只做"版本已经存在之后"的事：列版本、回滚切指针、标记删除、读时间线。
 * 把回滚放这儿而不是 `ReleaseRepo`，是因为 `ReleaseRepo` 管的是受理那一个事务（机制 §3.0），
 * 两者写的表不同、并发保护也不同（回滚锁的是原型行，受理锁的是编码唯一索引）。
 *
 * 三条不变量：
 * 1. **`deletedAt: null` 与范围条件由调用方给**：本层按 prototypeId/projectId 查，可见性一律先由
 *    服务层问 `PrototypeRepo.findAccessible` / `ProjectRepo.findAccessible`（权限模型 §6.2），
 *    不在这里再写第二套判定。
 * 2. **回滚与标记删除都是一个小事务**：指针/状态与那条事件必须同时落地（§5.5「事务内完成」、
 *    §5.6「写 delete_version」），少一半就会出现"时间线上多一次没发生过的回滚"或反之。
 * 3. **`from_release_id`/`to_release_id` 没有外键**（数据库设计 §4.2.5 刻意如此），所以版本号要靠
 *    一次额外的 `proto_release` 查询取，取不到就是 null——事件不会因为版本行没了而读不出来。
 */

/** §5.4 的一行版本（`sourceName` 不在 release 表上，见 `sourceNamesOf`）。 */
export interface ReleaseRow {
  readonly contentHash: string;
  readonly createdAt: Date;
  readonly createdByName: string;
  readonly entryFile: string;
  readonly fileCount: number;
  readonly htmlRewrites: number;
  readonly id: bigint;
  readonly note: null | string;
  readonly cssRewrites: number;
  /** §3.5 发布报告的条目，取自 `manifest.warnings`；清单被人工改坏时是空数组而不是抛错 */
  readonly report: readonly UploadTaskWarning[];
  readonly sourceSize: number;
  readonly status: ReleaseStatus;
  readonly totalBytes: number;
  readonly versionNo: number;
}

/** 回滚成功后的人话素材：审计与界面都要能说"从第几版回到第几版"。 */
export interface RollbackResult {
  readonly fromVersionNo: null | number;
  readonly toVersionNo: number;
}

/** §5.6 的三种结果：当前生效版本不能删；查不到（不存在/不属于该原型/已删过）都算 not-found。 */
export type DeleteOutcome =
  | { readonly kind: 'current' }
  | { readonly kind: 'deleted'; readonly versionNo: null | number }
  | { readonly kind: 'not-found' };

/**
 * §5.8 的一条版本事件。
 *
 * `prototypeCode`/`prototypeName` 只在项目级动态里用（§5.8 末段），所以是另一个类型而不是
 * 这里的可选字段——可选字段会让服务层为一个"项目视图里必然存在"的值写空值分支。
 */
export interface ReleaseEventRow {
  readonly createdAt: Date;
  readonly eventType: ReleaseEventType;
  readonly fromVersionNo: null | number;
  readonly id: bigint;
  readonly operatorName: string;
  readonly reason: null | string;
  readonly toVersionNo: null | number;
}

export interface ProjectReleaseEventRow extends ReleaseEventRow {
  readonly prototypeCode: string;
  readonly prototypeName: string;
}

/**
 * §3.1 工作台的一行动态。
 *
 * 这里没有 `fromVersionNo`/`toVersionNo`：工作卡的右栏只说"谁在什么时候对哪个原型做了什么"，
 * 版本号要多一次 `proto_release` 回查（见 `versionNosOf`）才拿得到。判据里没有它，
 * 就按没有的设计取，而不是顺手多打一次库——需要版本号的地方永远有那条时间线可看。
 */
export interface RecentReleaseEventRow {
  readonly createdAt: Date;
  readonly eventType: ReleaseEventType;
  readonly id: bigint;
  readonly operatorName: string;
  readonly projectName: string;
  readonly prototypeCode: string;
  readonly prototypeName: string;
  readonly reason: null | string;
}


const OPERATOR_SELECT = { select: { realName: true, username: true } } as const;

const RELEASE_LIST_SELECT = {
  contentHash: true,
  createdAt: true,
  createdByUser: OPERATOR_SELECT,
  entryFile: true,
  fileCount: true,
  id: true,
  manifest: true,
  note: true,
  sourceSize: true,
  status: true,
  totalBytes: true,
  versionNo: true,
} satisfies Prisma.ProtoReleaseSelect;

type ReleaseEntity = Prisma.ProtoReleaseGetPayload<{ select: typeof RELEASE_LIST_SELECT }>;

const DEFAULT_PAGE_SORTS = ['createdAt', 'versionNo'] as const;

/** §5.4 支持的排序字段（其余一律 400，不静默忽略——静默忽略会让"排序看起来没生效"）。 */
export const RELEASE_SORT_FIELDS: readonly string[] = DEFAULT_PAGE_SORTS;

/** §5.8 的时间线只有时间可排（事件行没有别的业务列），所以白名单只有一项。 */
export const RELEASE_EVENT_SORT_FIELDS: readonly string[] = ['createdAt'];

/** 两条时间线共用的一份取列（抽出来是为了让 `EventEntity` 的类型与运行时 select 同源）。 */
const EVENT_SELECT = {
  createdAt: true,
  eventType: true,
  fromReleaseId: true,
  id: true,
  operator: OPERATOR_SELECT,
  prototype: { select: { code: true, name: true } },
  reason: true,
  toReleaseId: true,
} satisfies Prisma.ProtoReleaseEventSelect;

type EventEntity = Prisma.ProtoReleaseEventGetPayload<{ select: typeof EVENT_SELECT }>;

/**
 * 工作台「最近动态」的取列：比时间线多一个项目名。
 * §3.1 的一行要同时说"哪个项目的哪个原型"，而两条时间线都是在一个项目/一个原型内部看的，
 * 所以那一列只在这里加——不扩 `EVENT_SELECT`，免得两个时间线的响应各自多带一个没人看的字段。
 */
const SCOPE_EVENT_SELECT = {
  ...EVENT_SELECT,
  prototype: {
    select: { code: true, name: true, project: { select: { name: true } } },
  },
} satisfies Prisma.ProtoReleaseEventSelect;

type ScopeEventEntity = Prisma.ProtoReleaseEventGetPayload<{
  select: typeof SCOPE_EVENT_SELECT;
}>;

@Injectable()
export class VersionRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /**
   * §5.4 版本列表：只看这个原型下未标记删除的版本，按版本号倒序（新的在前）。
   * `sortBy` 交给调用方收敛（`assertSortField`），这里只保证"默认最新的在最前"。
   */
  async listForPrototype(
    prototypeId: bigint,
    page: NormalizedPageQuery,
  ): Promise<{ rows: ReleaseRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.db.protoRelease.findMany({
        orderBy: releaseOrderBy(page.sortBy, page.sortOrder ?? 'desc'),
        select: RELEASE_LIST_SELECT,
        skip: page.skip,
        take: page.pageSize,
        where: { deletedAt: null, prototypeId },
      }),
      this.db.protoRelease.count({ where: { deletedAt: null, prototypeId } }),
    ]);
    return { rows: rows.map(toReleaseRow), total };
  }

  /**
   * 工作台 §3.1 的 `releaseStats`：可见范围内新落地的版本数（本周 / 今天）。
   *
   * 数 `proto_release` 行而不是数 `publish` 事件：两者在"成功发布"上一一对应（机制 §3.1 同事务写），
   * 但回滚与重新上架只补事件、不补版本行——那句"本周发布次数"问的是新版本，版本行才是那个数。
   * 过滤条件与 §5.4 版本列表同一条（`deletedAt: null`，状态不再筛）：被标记删除的版本在列表里已经
   * 不出现，计数也不该把它算回来；而 broken 版本列表照样展示，所以它同样算一次发布。
   */
  async publishedCounts(
    prototypeWhere: Prisma.ProtoPrototypeWhereInput,
    window: { readonly thisWeekStart: Date; readonly todayStart: Date },
  ): Promise<ReleaseStats> {
    const count = (since: Date) =>
      this.db.protoRelease.count({
        where: { createdAt: { gte: since }, deletedAt: null, prototype: prototypeWhere },
      });
    const [thisWeek, today] = await Promise.all([
      count(window.thisWeekStart),
      count(window.todayStart),
    ]);
    return { thisWeek, today };
  }

  /**
   * 原始包文件名（§5.4 的 `sourceName`）。
   *
   * `proto_release` 上只有 `source_hash`/`source_size`，文件名只存在于任务行（数据库设计 §4.2.2 的
   * 列清单如此）：一次成功的发布恰好留下一条 `release_id` 指向它的任务，所以按 release id 回查。
   * 同一次重试失败的那些任务 `release_id` 是 null，不会被算进来。
   */
  async sourceNamesOf(
    prototypeId: bigint,
    releaseIds: readonly bigint[],
  ): Promise<Map<string, string>> {
    if (releaseIds.length === 0) {
      return new Map();
    }
    const rows = await this.db.protoUploadTask.findMany({
      select: { releaseId: true, sourceName: true },
      where: { prototypeId, releaseId: { in: [...releaseIds] } },
    });
    return new Map(
      rows
        .filter((row): row is { releaseId: bigint; sourceName: string } => row.releaseId !== null)
        .map((row) => [row.releaseId.toString(), row.sourceName]),
    );
  }

  /** §5.3 成功时的版本摘要：只有当前这条任务的 releaseId，按 id 取那几列。 */
  async findSummary(releaseId: bigint): Promise<ReleaseRow | null> {
    const row = await this.db.protoRelease.findFirst({
      select: RELEASE_LIST_SELECT,
      where: { id: releaseId },
    });
    return row === null ? null : toReleaseRow(row);
  }

  /**
   * §5.5 回滚：把当前生效指针换成目标版本。所有校验都在锁内做，服务层只判数据范围——
   * 同一条规则不留两处真相（§3.7），而"归档/版本状态"在服务层读到时确实还可能被人改。
   *
   * 并发保护与机制 §3.1 同源：`FOR UPDATE` 锁住原型行，所以回滚不会与一次正在提交的发布交错。
   * 项目归档也要在锁内判（§5.5 点名 `PROJECT_ARCHIVED`）：归档容器里放出一条能点开的链接，
   * 与 §5.1 拒绝向归档原型发布是同一条访问决策（机制 §5.3），两处口径必须一致。
   */
  async rollback(input: {
    readonly prototypeId: bigint;
    readonly reason: string | null;
    readonly releaseId: bigint;
    readonly userId: bigint;
  }): Promise<RollbackResult> {
    return this.db.$transaction(async (client) => {
      const locked = await lockRollbackTarget(client, input.prototypeId, input.releaseId);
      await client.protoPrototype.update({
        data: {
          currentReleaseId: input.releaseId,
          publishedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: input.userId,
        },
        where: { id: input.prototypeId },
      });
      await client.protoReleaseEvent.create({
        data: {
          eventType: 'rollback',
          fromReleaseId: locked.currentReleaseId,
          operatorId: input.userId,
          prototypeId: input.prototypeId,
          reason: input.reason,
          toReleaseId: input.releaseId,
        },
        select: { id: true },
      });
      return {
        fromVersionNo: locked.currentVersionNo,
        toVersionNo: locked.targetVersionNo,
      };
    });
  }

  /**
   * §5.6 标记删除版本：置 `status='deleted'` + `deleted_at`，产物物理回收留给 GC（计划 M5-T6）。
   * 唯一硬规则是"不能删当前生效版本"，所以先锁原型行读指针；条件写在 updateMany 的 where 里
   * （未删过 + 归属该原型），并发下第二次 `count=0` → 服务层按"该版本已删除"回 404。
   *
   * 归档不拦：删掉一个已下架原型的历史版本不改变任何人的可访问链接（当前版本仍在 §5.5 那条规则里保住）。
   */
  async markDeleted(input: {
    readonly releaseId: bigint;
    readonly prototypeId: bigint;
    readonly userId: bigint;
  }): Promise<DeleteOutcome> {
    return this.db.$transaction(async (client) => {
      const rows = await client.$queryRaw<Array<{ current_release_id: bigint | null }>>`
        select current_release_id
        from proto_prototype
        where id = ${input.prototypeId}
          and deleted_at is null
        for update`;
      const locked = rows[0];
      if (locked === undefined) {
        return { kind: 'not-found' };
      }
      if (locked.current_release_id === input.releaseId) {
        return { kind: 'current' };
      }
      const marked = await client.protoRelease.updateMany({
        data: { deletedAt: new Date(), status: 'deleted' },
        where: {
          deletedAt: null,
          id: input.releaseId,
          prototypeId: input.prototypeId,
          status: { not: 'deleted' },
        },
      });
      if (marked.count === 0) {
        return { kind: 'not-found' };
      }
      await client.protoReleaseEvent.create({
        data: {
          eventType: 'delete_version',
          fromReleaseId: input.releaseId,
          operatorId: input.userId,
          prototypeId: input.prototypeId,
        },
        select: { id: true },
      });
      // 审计要能说出"删了第几版"；行已经在这条事务里改过了，按 id 回读一次版本号即可。
      const deleted = await client.protoRelease.findFirst({
        select: { versionNo: true },
        where: { id: input.releaseId },
      });
      return { kind: 'deleted', versionNo: deleted?.versionNo ?? null };
    });
  }

  /** §5.8 原型时间线。 */
  async listPrototypeEvents(
    prototypeId: bigint,
    page: NormalizedPageQuery,
  ): Promise<{ rows: ReleaseEventRow[]; total: number }> {
    const { entities, total, versionNos } = await this.fetchEvents(
      { deletedAt: null, id: prototypeId },
      page,
    );
    return { rows: entities.map((entity) => toEventRow(entity, versionNos)), total };
  }

  /** §5.8 项目级动态：同一张表按项目聚合，多带原型名与原型码两级信息。 */
  async listProjectEvents(
    projectId: bigint,
    page: NormalizedPageQuery,
  ): Promise<{ rows: ProjectReleaseEventRow[]; total: number }> {
    const { entities, total, versionNos } = await this.fetchEvents(
      { deletedAt: null, project: { id: projectId } },
      page,
    );
    return {
      rows: entities.map((entity) => ({
        ...toEventRow(entity, versionNos),
        prototypeCode: entity.prototype.code,
        prototypeName: entity.prototype.name,
      })),
      total,
    };
  }

  /**
   * 工作台「最近动态」（§3.1）：整个可见范围内的最新 N 条事件，不分组、不计数。
   *
   * `prototypeWhere` 由服务层给（同两条时间线的口径：软删原型的事件不进视图），这里只负责取列；
   * 不查总数——右栏是定长列表，`count` 那一次库换来的是没人看的数字。
   */
  async listRecentEvents(
    prototypeWhere: Prisma.ProtoPrototypeWhereInput,
    limit: number,
  ): Promise<RecentReleaseEventRow[]> {
    const entities = await this.db.protoReleaseEvent.findMany({
      orderBy: { createdAt: 'desc' },
      select: SCOPE_EVENT_SELECT,
      take: limit,
      where: { prototype: prototypeWhere },
    });
    return entities.map(toRecentEventRow);
  }

  /**
   * 两张视图共用同一次查询：原型总是 join 出来（多两列的成本在同一个 JOIN 里，不值得为它
   * 写两份 select 与两个映射分支），软删原型的事件不进视图——它的版本已经看不见了。
   */
  private async fetchEvents(
    prototypeWhere: Prisma.ProtoPrototypeWhereInput,
    page: NormalizedPageQuery,
  ): Promise<{
    entities: EventEntity[];
    total: number;
    versionNos: Map<string, number>;
  }> {
    const where = { prototype: prototypeWhere };
    const entities = await this.db.protoReleaseEvent.findMany({
      orderBy: { createdAt: page.sortOrder ?? 'desc' },
      select: EVENT_SELECT,
      skip: page.skip,
      take: page.pageSize,
      where,
    });
    const total = await this.db.protoReleaseEvent.count({ where });
    return { entities, total, versionNos: await this.versionNosOf(releaseIdsOf(entities)) };
  }

  /** 事件的 from/to 只有 id，版本号要回 `proto_release` 取（这两列刻意不建外键，见 §4.2.5）。 */
  private async versionNosOf(ids: bigint[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.db.protoRelease.findMany({
      select: { id: true, versionNo: true },
      where: { id: { in: ids } },
    });
    return new Map(rows.map((row) => [row.id.toString(), row.versionNo]));
  }
}

/** 锁原型行并把 §5.5 的四条校验在锁内判完，一次拿齐回滚要写的值。 */
async function lockRollbackTarget(
  client: Prisma.TransactionClient,
  prototypeId: bigint,
  releaseId: bigint,
): Promise<{
  currentReleaseId: null | bigint;
  currentVersionNo: null | number;
  targetVersionNo: number;
}> {
  const locked = (
    await client.$queryRaw<Array<{ archived_at: Date | null; current_release_id: bigint | null; status: string }>>`
      select p.status, p.current_release_id, j.archived_at
      from proto_prototype p
      join proto_project j on j.id = p.project_id
      where p.id = ${prototypeId}
        and p.deleted_at is null
      for update of p`
  )[0];
  if (locked === undefined) {
    throw new BusinessException(
      '原型已被删除，无法回滚',
      ERROR_CODES.PROTO_NOT_FOUND,
      404,
    );
  }
  if (locked.archived_at !== null) {
    throw new BusinessException(
      '该项目已归档，先恢复项目再回滚',
      ERROR_CODES.PROJECT_ARCHIVED,
      400,
    );
  }
  if (locked.status === 'archived') {
    throw new BusinessException(
      '该原型已下架，请先恢复上架再回滚',
      ERROR_CODES.PROTO_ARCHIVED,
      400,
    );
  }
  const target = await client.protoRelease.findFirst({
    select: { deletedAt: true, status: true, versionNo: true },
    where: { id: releaseId, prototypeId },
  });
  if (target === null) {
    throw releaseNotFoundError();
  }
  if (target.deletedAt !== null || target.status === 'deleted') {
    throw releaseNotFoundError();
  }
  if (target.status !== 'ready') {
    throw new BusinessException(
      '该版本的产物已损坏（broken），不能回滚到它',
      ERROR_CODES.RELEASE_NOT_READY,
      400,
    );
  }
  if (locked.current_release_id === releaseId) {
    throw new BusinessException(
      `版本 v${String(target.versionNo)} 已经是当前生效版本`,
      ERROR_CODES.RELEASE_IS_CURRENT,
      400,
    );
  }
  const current =
    locked.current_release_id === null
      ? null
      : await client.protoRelease.findFirst({
          select: { versionNo: true },
          where: { id: locked.current_release_id },
        });
  return {
    currentReleaseId: locked.current_release_id,
    currentVersionNo: current?.versionNo ?? null,
    targetVersionNo: target.versionNo,
  };
}

/** §5.4 只有两列可排（`sortBy` 已经过服务层的白名单收敛）；缺省按版本号，列表要"最新的在前"。 */
function releaseOrderBy(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
): Prisma.ProtoReleaseOrderByWithRelationInput {
  return sortBy === 'createdAt' ? { createdAt: sortOrder } : { versionNo: sortOrder };
}

/**
 * 版本不属于该原型 / 已删除 / 查不到：同一个 404，不给"这条 id 存在但不是你的"的状态差（同 §6.2 的取向）。
 * 导出是因为服务层的 `updateMany` 竞争失败（`count=0`）要说同一句话——同一种失败只该有一个出处。
 */
export function releaseNotFoundError(): BusinessException {
  return new BusinessException('版本不存在或已删除', ERROR_CODES.RELEASE_NOT_FOUND, 404);
}

function toReleaseRow(entity: ReleaseEntity): ReleaseRow {
  return {
    contentHash: entity.contentHash,
    createdAt: entity.createdAt,
    createdByName: displayName(entity.createdByUser),
    entryFile: entity.entryFile,
    fileCount: entity.fileCount,
    htmlRewrites: rewritesOf(entity.manifest).html,
    id: entity.id,
    note: entity.note,
    cssRewrites: rewritesOf(entity.manifest).css,
    report: reportOf(entity.manifest),
    sourceSize: Number(entity.sourceSize),
    status: toReleaseStatus(entity.status),
    totalBytes: Number(entity.totalBytes),
    versionNo: entity.versionNo,
  };
}

function toEventRow(entity: EventEntity, versionNos: Map<string, number>): ReleaseEventRow {
  return {
    createdAt: entity.createdAt,
    eventType: toEventType(entity.eventType),
    fromVersionNo: versionIdOf(entity.fromReleaseId, versionNos),
    id: entity.id,
    operatorName: displayName(entity.operator),
    reason: entity.reason,
    toVersionNo: versionIdOf(entity.toReleaseId, versionNos),
  };
}

function toRecentEventRow(entity: ScopeEventEntity): RecentReleaseEventRow {
  return {
    createdAt: entity.createdAt,
    eventType: toEventType(entity.eventType),
    id: entity.id,
    operatorName: displayName(entity.operator),
    projectName: entity.prototype.project.name,
    prototypeCode: entity.prototype.code,
    prototypeName: entity.prototype.name,
    reason: entity.reason,
  };
}

function versionIdOf(
  releaseId: bigint | null,
  versionNos: Map<string, number>,
): null | number {
  return releaseId === null ? null : versionNos.get(releaseId.toString()) ?? null;
}

function releaseIdsOf(
  entities: readonly { fromReleaseId: bigint | null; toReleaseId: bigint | null }[],
): bigint[] {
  const ids = new Set<string>();
  const result: bigint[] = [];
  for (const entity of entities) {
    for (const id of [entity.fromReleaseId, entity.toReleaseId]) {
      if (id !== null && !ids.has(id.toString())) {
        ids.add(id.toString());
        result.push(id);
      }
    }
  }
  return result;
}

/** varchar + CHECK（迁移原生 SQL）→ 联合类型；越界值按最保守取值（同 PrototypeRepo.toRow）。 */
function toReleaseStatus(value: string): ReleaseStatus {
  return (RELEASE_STATUSES as readonly string[]).includes(value)
    ? (value as ReleaseStatus)
    : 'deleted';
}

function toEventType(value: string): ReleaseEventType {
  return (RELEASE_EVENT_TYPES as readonly string[]).includes(value)
    ? (value as ReleaseEventType)
    : 'publish';
}

/**
 * `manifest.rewrites`（机制 §2.7）是 jsonb：读不到就当 0 而不是抛。
 * 一条版本列表不该因为某次人工改坏的清单而整页打不开，而"改写了几处"只是报告里的补充信息。
 */
function rewritesOf(manifest: Prisma.JsonValue): { css: number; html: number } {
  const rewrites = isRecord(manifest) ? manifest['rewrites'] : undefined;
  const html = isRecord(rewrites) ? toCount(rewrites['html']) : 0;
  const css = isRecord(rewrites) ? toCount(rewrites['css']) : 0;
  return { css, html };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/**
 * `manifest.warnings`（机制 §2.7）：这一版的发布报告正文。
 * 读法与任务行共用 `warnings-codec`——同一条告警在两处落库，判定不能分家（§3.7）。
 */
function reportOf(manifest: Prisma.JsonValue): readonly UploadTaskWarning[] {
  return toWarnings(isRecord(manifest) ? (manifest['warnings'] ?? null) : null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayName(user: { realName: string; username: string }): string {
  return user.realName || user.username;
}

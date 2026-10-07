import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  ACCESS_LOG_DEVICES,
  ACCESS_LOG_RESULTS,
  type AccessLogDailyPoint,
  type AccessLogDevice,
  type AccessLogItem,
  type AccessLogResult,
  type AccessLogSummary,
  type AccessLogTopPrototype,
  type VisitStats,
} from '@protohub/shared';
import { z } from 'zod';

import { localDayStart } from '../../common/calendar-window';
import { projectScopeWhere, toActorScope } from '../../common/data-scope';
import {
  toPageData,
  type NormalizedPageQuery,
  type PageData,
} from '../../common/pagination/pagination';
import { PermissionCodeService } from '../../common/permission/permission-code.service';
import type { Actor } from '../system/common/actor';
import {
  optionalQueryBoolean,
  optionalQueryDateTime,
  optionalQueryId,
  optionalQueryText,
} from '../system/common/dto';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';
import {
  type AccessLogAggregateRow,
  type AccessLogConditions,
  type AccessLogDailyRow,
  type AccessLogPrototypeCountRow,
  type AccessLogRawRow,
  type AccessLogRefererCountRow,
  AccessLogQueryRepo,
} from './access-log.query.repo';

/**
 * 访问记录读侧（[后端接口设计.md](../../../../../docs/后端接口设计.md) §6.1/§6.2；迭代实施计划 M4-T10）。
 *
 * 这一层负责三件 SQL 不该管的事：
 * 1. **数据范围**：`AccessLogListQuery` 里根本没有范围字段（接口设计 §6.1 没写），但 publisher/viewer
 *    都握着 `proto:accesslog:list` 且 `data_scope=member`（权限模型 §3.5/§5 角色表），而行里带着访客 IP
 *    ——不叠范围就等于让任一 viewer 读到别人项目的流量。判定继续走 `projectScopeWhere` 那一份真相，
 *    这里只把它解析成"哪些原型可见 ∪ 哪些项目编码可见"两个集合交给 SQL；
 * 2. **IP 打码**：默认打码，`system:log:list` 及以上才认 `maskIp=false`；
 * 3. **降级展示**：编码不存在/原型已删/项目查不到时，名字类字段一律 null，只留 `routeKey`（§6.1）。
 */

/** §6.2：`days` 默认 7、上限 90（下限 1 是"只想要今天"的合理请求，不给 0）。 */
export const ACCESS_LOG_SUMMARY_DEFAULT_DAYS = 7;
export const ACCESS_LOG_SUMMARY_MAX_DAYS = 90;
export const ACCESS_LOG_SUMMARY_MIN_DAYS = 1;

/** §6.1 里能看明文 IP 的那枚码：接口设计写的是"`system:log:list` 及以上可请求"，按权限码判定而不是按角色名。 */
export const RAW_IP_PERMISSION = 'system:log:list';

/**
 * 工作台 §3.1 的访问窗口：与 §6.2 汇总页的默认窗口同一条（7 个日历日），
 * 环比（前端设计 §3.1「近 7 天访问量（含环比小字）」）要多取一个等长窗口，所以日桶取 14 天。
 */
export const DASHBOARD_VISIT_DAYS = ACCESS_LOG_SUMMARY_DEFAULT_DAYS;
const DASHBOARD_TREND_DAYS = DASHBOARD_VISIT_DAYS * 2;

/**
 * 查询契约（类型来自 `@protohub/shared` 的 `AccessLogListQuery`，这里只补 GET 侧的形态处理）。
 *
 * `page/pageSize` 不在 schema 里：它们交给公共归一化（`pageQueryFrom`），默认 20 / 上限 200 的夹取
 * 规则只在一处实现（§1.3/§1.5）。重复键（`?result=ok&result=not_found`）在 Fastify 解析后是数组，
 * 下面这些标量字段自然校验不过 → 400，而不是"悄悄只用其中一个值"。
 */
export const accessLogListQuerySchema = z
  .object({
    endTime: optionalQueryDateTime(),
    keyword: optionalQueryText(120),
    maskIp: optionalQueryBoolean(),
    projectId: optionalQueryId(),
    prototypeId: optionalQueryId(),
    // 越界的 result 直接 400：把它当"没筛"会返回全量，用户看到的是"筛选没生效"而不是"值不对"。
    result: z.preprocess(
      (value: unknown) =>
        typeof value === 'string' && value.trim() === '' ? undefined : value,
      z.enum(ACCESS_LOG_RESULTS).optional(),
    ),
    startTime: optionalQueryDateTime(),
  })
  // 区间反了不静默交换：交换等于替用户改了一次查询条件，他会在错误的窗口里得出"最近没人访问"的结论。
  .superRefine((value, context) => {
    if (value.startTime !== undefined && value.endTime !== undefined && value.startTime > value.endTime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '开始时间不能晚于结束时间',
        path: ['startTime'],
      });
    }
  });

/** §6.2：全局汇总（两个 id 都不传）/ 按项目 / 按原型，三种视图共用一条查询契约。 */
export const accessLogSummaryQuerySchema = z.object({
  // 非数字（`days=abc`）在这一层就 400；数字越界留给 `resolveSummaryDays` 夹取，两者不要混成一种失败。
  days: z.preprocess(
    (value: unknown) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().optional(),
  ),
  projectId: optionalQueryId(),
  prototypeId: optionalQueryId(),
});

export type AccessLogListFilter = z.infer<typeof accessLogListQuerySchema>;
export type AccessLogSummaryFilter = z.infer<typeof accessLogSummaryQuerySchema>;

/** 范围解析结果：`empty` = 这个人在范围内什么项目都没有，直接回空页，不必再扫日志表。 */
type ScopeResolution =
  | { readonly kind: 'all' }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'visible';
      readonly projectCodes: readonly string[];
      readonly prototypeIds: readonly bigint[];
    };

/** `projectId` 筛选项的解析结果：`missing` = 库里没有这个项目，任何日志都不该命中。 */
type ProjectFilterResolution =
  | { readonly kind: 'none' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'resolved';
      readonly code: string;
      readonly prototypeIds: readonly bigint[];
    };

/**
 * 条件组装只留一处：列表与汇总共用它，`pv`/`uv`/榜单才会与明细行严格同口径。
 * 各取默认 `null`（= 不加这一支条件），所以调用方不需要重复写"没筛"的分支。
 */
function buildConditions(input: {
  readonly endAt?: null | Date;
  readonly keyword?: null | string;
  readonly project: null | { readonly code: string; readonly prototypeIds: readonly bigint[] };
  readonly prototypeId: null | bigint;
  readonly result?: null | string;
  readonly scope: null | { readonly projectCodes: readonly string[]; readonly prototypeIds: readonly bigint[] };
  readonly startAt?: null | Date;
}): AccessLogConditions {
  return {
    endAt: input.endAt ?? null,
    keyword: input.keyword ?? null,
    project: input.project,
    prototypeId: input.prototypeId,
    result: input.result ?? null,
    scope: input.scope,
    startAt: input.startAt ?? null,
  };
}

@Injectable()
export class AccessLogQueryService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly repo: AccessLogQueryRepo,
    private readonly permissionCodes: PermissionCodeService,
  ) {}

  /** §6.1 明细分页。`ip` 是否打码在这里定，因为判定要读权限而不是读 SQL。 */
  async list(
    actor: Actor,
    filter: AccessLogListFilter,
    page: NormalizedPageQuery,
  ): Promise<PageData<AccessLogItem>> {
    const scope = await this.resolveScope(actor);
    const projectFilter = await this.resolveProjectFilter(filter.projectId);
    if (scope.kind === 'empty' || projectFilter.kind === 'missing') {
      return toPageData([], 0);
    }

    const { rows, total } = await this.repo.findPage(
      buildConditions({
        endAt: filter.endTime ?? null,
        keyword: filter.keyword ?? null,
        project: resolvedProject(projectFilter),
        prototypeId: filter.prototypeId === undefined ? null : BigInt(filter.prototypeId),
        result: filter.result ?? null,
        scope: resolvedScope(scope),
        startAt: filter.startTime ?? null,
      }),
      page,
    );

    // 只有明说要 `maskIp=false` **且**握着那枚码才给明文；缺权限时忽略参数而不报 403——
    // §6.1 的措辞是"可请求"，即这是请求者的附加权限，不是列表接口的前置条件。
    const showRawIp =
      filter.maskIp === false &&
      (await this.allowsRawIp(actor));

    return toPageData(
      rows.map((row) => toAccessLogItem(row, showRawIp ? row.ip : maskIpTail(row.ip))),
      total,
    );
  }

  /** §6.2 汇总：五个指标 + 趋势 + 两张榜，同一条条件一次算完（拆成两次判定就会出现"卡片与折线对不上"）。 */
  async summary(actor: Actor, filter: AccessLogSummaryFilter): Promise<AccessLogSummary> {
    const days = resolveSummaryDays(filter.days);
    const window = buildSummaryWindow(days);
    const scope = await this.resolveScope(actor);
    const projectFilter = await this.resolveProjectFilter(filter.projectId);
    if (scope.kind === 'empty' || projectFilter.kind === 'missing') {
      return emptySummary(window.keys);
    }

    const conditions = buildConditions({
      project: resolvedProject(projectFilter),
      prototypeId: filter.prototypeId === undefined ? null : BigInt(filter.prototypeId),
      scope: resolvedScope(scope),
      // 窗口只有下界：`days` 是"最近 N 个日历日含今天"，上界就是现在，写 `<= now()` 只会因时钟差把刚落的行切掉。
      startAt: window.start,
    });

    const [aggregate, dailyRows, prototypeRows, refererRows] = await Promise.all([
      this.repo.aggregate(conditions),
      this.repo.daily(conditions),
      this.repo.topPrototypes(conditions),
      this.repo.topReferers(conditions),
    ]);

    return {
      botPv: Number(aggregate.bot_pv),
      daily: fillDaily(window.keys, dailyRows),
      denied: Number(aggregate.denied),
      invalidPv: Number(aggregate.invalid_pv),
      pv: Number(aggregate.pv),
      topPrototypes: await this.nameTopPrototypes(prototypeRows),
      topReferers: refererRows
        .filter((row): row is AccessLogRefererCountRow & { origin: string } => row.origin !== null)
        .map((row) => ({ pv: Number(row.pv), referer: row.origin })),
      uv: Number(aggregate.uv),
    };
  }

  /**
   * 工作台 §3.1 的 `visitStats`。
   *
   * 与 §6.2 汇总页共用同一条范围解析（`resolveScope`）和同一把日历日窗口尺子，所以工作台的
   * "近 7 天访问"点开到访问记录页一定对得上。两次查询而不是五次：日桶出三个访问量
   * （必须同一份桶，见 `toVisitStats`），汇总行出 UV 与被拒次数。
   */
  async dashboardVisitStats(actor: Actor): Promise<VisitStats> {
    const scope = await this.resolveScope(actor);
    if (scope.kind === 'empty') {
      return emptyVisitStats();
    }
    const trend = buildSummaryWindow(DASHBOARD_TREND_DAYS);
    const window = buildSummaryWindow(DASHBOARD_VISIT_DAYS);
    const base = { project: null, prototypeId: null, scope: resolvedScope(scope) };
    const [dailyRows, aggregate] = await Promise.all([
      this.repo.daily(buildConditions({ ...base, startAt: trend.start })),
      this.repo.aggregate(buildConditions({ ...base, startAt: window.start })),
    ]);
    return toVisitStats(dailyRows, trend.keys, aggregate);
  }

  /**
   * 可见项目 → 两个集合：这些项目下的原型 id + 项目编码本身。
   *
   * 为什么两样都要：日志行可能只有 `route_key`（`prototype_id` 为空——编码不存在时的那条路），
   * 而"这一条属于哪个项目"在这种行上只能靠 `route_key` 的第一段（权限模型 §6.2：原型的可见性一律由
   * 父项目决定，所以日志的归属项目必须对请求者可见）。
   *
   * **不叠 `deletedAt: null`**（与项目列表那侧不同）：成员该看得见自己项目里"旧链接还在被访问"的记录，
   * 那些行恰恰挂在已软删的原型/项目上；行本身的降级展示由 §6.1 的映射负责。
   */
  private async resolveScope(actor: Actor): Promise<ScopeResolution> {
    if (actor.dataScope === 'all') {
      return { kind: 'all' };
    }
    const where = projectScopeWhere(toActorScope(actor));
    const [projects, prototypes] = await Promise.all([
      this.db.protoProject.findMany({ select: { code: true }, where }),
      this.db.protoPrototype.findMany({ select: { id: true }, where: { project: where } }),
    ]);
    if (projects.length === 0 && prototypes.length === 0) {
      return { kind: 'empty' };
    }
    return {
      kind: 'visible',
      projectCodes: projects.map((project) => project.code),
      prototypeIds: prototypes.map((prototype) => prototype.id),
    };
  }

  /** `projectId` 筛选：把项目 id 翻译成它自己的编码 + 其下全部原型，与范围条件求交（不是替换范围）。 */
  private async resolveProjectFilter(
    projectId: string | undefined,
  ): Promise<ProjectFilterResolution> {
    if (projectId === undefined) {
      return { kind: 'none' };
    }
    // 不带 `deletedAt: null`：项目软删后其历史流量仍归原成员可见，筛它不该先撞一次"项目不存在"。
    const project = await this.db.protoProject.findFirst({
      select: { code: true, id: true },
      where: { id: BigInt(projectId) },
    });
    if (project === null) {
      return { kind: 'missing' };
    }
    const prototypes = await this.db.protoPrototype.findMany({
      select: { id: true },
      where: { projectId: project.id },
    });
    return {
      kind: 'resolved',
      code: project.code,
      prototypeIds: prototypes.map((prototype) => prototype.id),
    };
  }

  /**
   * 明文 IP 的资格：超管短路（同 Guard 的 C-5），其余按权限码查（那枚码在 30 秒缓存里，不打库）。
   * 只在 `maskIp=false` 时才会被调用到——默认路径一次权限查询都不该有。
   */
  private async allowsRawIp(actor: Actor): Promise<boolean> {
    if (actor.isSuperAdmin) {
      return true;
    }
    const codes = await this.permissionCodes.codesOfUser(actor.userId);
    return codes.has(RAW_IP_PERMISSION);
  }

  /**
   * 榜单取名：`prototype_id` 没有外键（数据库设计 §4.1.16），所以计数里的 id 可能指向已经没了的行。
   * 取不到名字的行从榜里丢掉而不是显示"未知原型"——那张榜回答的是"哪个原型被看得最多"，
   * 一条说不出是谁的记录只会让人以为是数据坏了；它本来已经被算进 `invalidPv`。
   */
  private async nameTopPrototypes(
    rows: readonly AccessLogPrototypeCountRow[],
  ): Promise<AccessLogTopPrototype[]> {
    if (rows.length === 0) {
      return [];
    }
    const found = await this.db.protoPrototype.findMany({
      select: { code: true, id: true, name: true, project: { select: { name: true } } },
      where: { deletedAt: null, id: { in: rows.map((row) => row.prototype_id) } },
    });
    const byId = new Map(found.map((prototype) => [prototype.id.toString(), prototype]));
    const named: AccessLogTopPrototype[] = [];
    for (const row of rows) {
      const prototype = byId.get(row.prototype_id.toString());
      if (prototype === undefined) {
        continue;
      }
      named.push({
        code: prototype.code,
        name: prototype.name,
        projectName: prototype.project.name,
        prototypeId: row.prototype_id.toString(),
        pv: Number(row.pv),
      });
    }
    return named;
  }
}

// -----------------------------------------------------------------------------
// 纯函数（导出给单测直接断言）
// -----------------------------------------------------------------------------

function resolvedScope(scope: ScopeResolution): AccessLogConditions['scope'] {
  return scope.kind === 'visible'
    ? { projectCodes: scope.projectCodes, prototypeIds: scope.prototypeIds }
    : null;
}

function resolvedProject(
  filter: ProjectFilterResolution,
): AccessLogConditions['project'] {
  return filter.kind === 'resolved'
    ? { code: filter.code, prototypeIds: filter.prototypeIds }
    : null;
}

/**
 * `days` 缺失给 7；越界夹到 1..90 而不是报错——图表少一天数据不值得让整页 400。
 * `!Number.isFinite` 那条分支 schema 层已经拦掉（`days=abc` → 400），留在这里是因为这个函数也被
 * 单测与未来的定时任务直接调用，而"传进来一个 NaN 就画出 90 天的空图"是最难查的那种失败。
 */
export function resolveSummaryDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days)) {
    return ACCESS_LOG_SUMMARY_DEFAULT_DAYS;
  }
  return Math.min(Math.max(Math.trunc(days), ACCESS_LOG_SUMMARY_MIN_DAYS), ACCESS_LOG_SUMMARY_MAX_DAYS);
}

/**
 * 统计窗口：最近 `days` 个**日历日**（含今天），按服务器本地时区算。
 *
 * 为什么是本地日历日而不是 `now - days*24h` 的滚动窗口（`project.repo` 的 `visitsLast7d` 用的是那种）：
 * §6.2 的产物是"按天折线"，滚动窗口会让第一天的柱子只统计半天，图上看着像流量腰斩。
 * 位移全部走 `common/calendar-window`（那里说明了为什么不能用 86400000 毫秒）。
 */
export function buildSummaryWindow(
  days: number,
  now: Date = new Date(),
): { readonly keys: readonly string[]; readonly start: Date } {
  const start = localDayStart(-(days - 1), now);
  const keys: string[] = [];
  for (let index = 0; index < days; index += 1) {
    keys.push(localDateKey(localDayStart(index, start)));
  }
  return { keys, start };
}

/** 本地日历日标签（`YYYY-MM-DD`）：窗口和分桶都用同一把尺子，图上的日期才与"今天"一致。 */
export function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 补齐零值日：库里没记录的日子在数组里也要出现（`pv: 0`），否则折线直接把那几天连起来，
 * 看起来就是"那几天流量正常"。
 *
 * 标签重复时按相加合并（而不是后者覆盖前者）：`group by date_trunc(...)` 正常一天一行，
 * 真出现两桶只能是我们改了分桶口径，相加至少不会把某一桶的量整个丢掉。
 * UV 相加会把两桶里的同一个访客重复计一次——要精确就得为这极少见的情况再加一条整窗口去重查询，
 * 而那一刻该修的是分桶口径本身。
 */
export function fillDaily(
  keys: readonly string[],
  rows: readonly AccessLogDailyRow[],
): AccessLogDailyPoint[] {
  const byDay = new Map<string, { pv: number; uv: number }>();
  for (const row of rows) {
    const key = localDateKey(row.day);
    const current = byDay.get(key) ?? { pv: 0, uv: 0 };
    byDay.set(key, { pv: current.pv + Number(row.pv), uv: current.uv + Number(row.uv) });
  }
  return keys.map((date) => {
    const point = byDay.get(date) ?? { pv: 0, uv: 0 };
    return { date, pv: point.pv, uv: point.uv };
  });
}

/** 空结果汇总：指标全 0，但 `daily` 仍按窗口补齐——空数组会让前端折线图整块不渲染（§6.2 的图是常驻卡片）。 */
export function emptySummary(keys: readonly string[]): AccessLogSummary {
  return {
    botPv: 0,
    daily: keys.map((date) => ({ date, pv: 0, uv: 0 })),
    denied: 0,
    invalidPv: 0,
    pv: 0,
    topPrototypes: [],
    topReferers: [],
    uv: 0,
  };
}

/**
 * 日桶 + 汇总行 → §3.1 工作台的 `visitStats`（纯函数，导出给单测直接断言）。
 *
 * `today`/`last7d`/`previous7d` 三个数从**同一份**日桶里加出来：环比的分子与分母必须来自同一次扫描，
 * 否则两次查询之间刚落一条记录就会出现"这周比上周少"的假变化。`keys` 是 `buildSummaryWindow(14)`
 * 的日标签——末 7 个是近 7 天、再往前 7 个是上一个 7 天、末位是今天；那天没人访问就没有桶，按 0 计。
 * UV 与被拒次数取汇总行：UV 要按 (本地日, ip, ua) 跨窗去重，而日桶里根本没有被拒这一档。
 */
export function toVisitStats(
  dailyRows: readonly AccessLogDailyRow[],
  keys: readonly string[],
  aggregate: Pick<AccessLogAggregateRow, 'denied' | 'uv'>,
): VisitStats {
  const pvByDay = new Map<string, number>();
  for (const row of dailyRows) {
    const key = localDateKey(row.day);
    pvByDay.set(key, (pvByDay.get(key) ?? 0) + Number(row.pv));
  }
  const sumOf = (window: readonly string[]): number =>
    window.reduce((total, key) => total + (pvByDay.get(key) ?? 0), 0);
  const current = keys.slice(-DASHBOARD_VISIT_DAYS);
  return {
    deniedLast7d: Number(aggregate.denied),
    last7d: sumOf(current),
    previous7d: sumOf(keys.slice(0, -DASHBOARD_VISIT_DAYS)),
    today: pvByDay.get(current.at(-1) ?? '') ?? 0,
    uvLast7d: Number(aggregate.uv),
  };
}

/** 范围内一个项目都没有：五个数全 0，卡片照常渲染——工作台不该因为"没数据"而缺一块布局（前端设计 §10.2）。 */
export function emptyVisitStats(): VisitStats {
  return { deniedLast7d: 0, last7d: 0, previous7d: 0, today: 0, uvLast7d: 0 };
}

/** IPv4：四段全数字。够不上这个形状的一律走保守分支（见 `maskIpTail`）。 */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** IPv6（含 `::ffff:1.2.3.4` 这类内嵌 IPv4 的映射地址）：首段是十六进制或空，后面才是冒号。 */
const IPV6_PATTERN = /^[0-9a-fA-F]*:[0-9a-fA-F:.]*$/;

/**
 * IP 打码：只保留前面几段，把最后一段换掉。
 *
 * 口径取自 §6.1 的规范句"最后一段打码"与 前端设计 §3.7 的"打码后一段"，
 * **不是** §6.1 JSON 样例里的 `116.226.x.x`——那句是示意：一次削两段就没法再按 /24 做流量归并，
 * 而这列存在的理由恰恰是让运维看出"同一个网段来的人"（以及 UV 为什么要带 ip）。所以：
 * - IPv4 `116.226.1.2` → `116.226.1.x`；
 * - IPv6 → 最后一组换成 `xxxx`；`::ffff:116.226.1.2` 这种映射地址也走同一条（结果是 `::ffff:xxxx`）——
 *   多值后缀里再挑"最后一段"要靠额外的四段判断，而这一列少露一段比多露一段划算；
 * - 认不出形状却带 `.`/`:` 的值（`1.2.3.4:8080`、`10.0.0.0/8` 这类畸形 inet 写法）：
 *   **只留第一段**，其余整段换成 `x`——判不出哪一段才是"最后一段"时，宁可少给也不能把疑似地址回显出去；
 * - 既不含 `.` 也不含 `:` 的值（主机名、内部标识）根本不是 IP，原样返回。
 */
export function maskIpTail(ip: null | string): null | string {
  if (ip === null) {
    return null;
  }
  if (IPV4_PATTERN.test(ip)) {
    return `${ip.slice(0, ip.lastIndexOf('.'))}.x`;
  }
  if (IPV6_PATTERN.test(ip)) {
    return `${ip.slice(0, ip.lastIndexOf(':') + 1)}xxxx`;
  }
  const index = ip.search(/[.:]/);
  if (index === -1) {
    return ip;
  }
  // 段首就是分隔符（`:1::`、`.foo`）：没有"第一段"可留，整个换掉。
  return index === 0 ? 'x' : `${ip.slice(0, index)}.x`;
}

/** `result` 是 varchar + 迁移里的 CHECK；读到字典外的值按 `not_found` 显示而不是让整页 500。 */
export function toAccessLogResult(value: string): AccessLogResult {
  return (ACCESS_LOG_RESULTS as readonly string[]).includes(value)
    ? (value as AccessLogResult)
    : 'not_found';
}

/** `device` 同样可空且越界只可能是脏数据：给 null（界面显示"-"）而不是编一个档位。 */
export function toAccessLogDevice(value: null | string): AccessLogDevice | null {
  return value !== null && (ACCESS_LOG_DEVICES as readonly string[]).includes(value)
    ? (value as AccessLogDevice)
    : null;
}

/**
 * 行 → §6.1 契约。三个降级条件在同一处判：`prototype_id` 为空、原型行没了、原型被软删——
 * 三种情况界面都要显示"无效链接"并且只剩 `routeKey` 可读，所以字段一起置 null（§6.1）。
 * 项目侧同理：行是由 `route_key` 第一段或原型的 `project_id` 解析的，解析不到就是 null。
 * `versionNo` 走 `release_id` 左连接，版本行没了自然为 null；`visitorName` 取 `sys_user.username`，
 * 匿名访问（`user_id` 为空）时是 null，由前端渲染成"匿名"。
 */
export function toAccessLogItem(row: AccessLogRawRow, ip: null | string): AccessLogItem {
  const prototypeAlive = row.prototype_id !== null && row.prototype_deleted_at === null;
  const projectAlive = row.project_id !== null && row.project_deleted_at === null;
  return {
    browser: row.browser,
    createdAt: row.created_at.toISOString(),
    device: toAccessLogDevice(row.device),
    id: row.id.toString(),
    ip,
    isBot: row.is_bot,
    os: row.os,
    path: row.path,
    projectId: projectAlive && row.project_id !== null ? row.project_id.toString() : null,
    projectName: projectAlive ? row.project_name : null,
    prototypeCode: prototypeAlive ? row.prototype_code : null,
    prototypeId:
      prototypeAlive && row.prototype_id !== null ? row.prototype_id.toString() : null,
    prototypeName: prototypeAlive ? row.prototype_name : null,
    referer: row.referer,
    result: toAccessLogResult(row.result),
    routeKey: row.route_key,
    userId: row.user_id === null ? null : row.user_id.toString(),
    versionNo: row.version_no,
    visitorName: row.visitor_name,
  };
}

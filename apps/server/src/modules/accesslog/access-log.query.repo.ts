import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 访问记录的读侧 SQL（[后端接口设计.md](../../../../../docs/后端接口设计.md) §6.1/§6.2；迭代实施计划 M4-T10）。
 *
 * 为什么走裸 SQL 而不是查询构造器：`proto_access_log` 的三个关联（`prototype_id` / `release_id` /
 * `user_id`）**刻意不建外键**（数据库设计 §2/§4.1.16：日志是统计事实，不约束业务删除，编码不存在时
 * 根本没有可指向的行），所以"这行日志属于哪个项目/原型叫什么/是哪个版本"只能是左连接后再判空，
 * 而 Prisma 的 `include` 依赖关系字段，无外键就没关系可 include。汇总侧的 `filter (where …)` 与
 * `count(distinct (日期, ip, ua))`（§6.2 的 UV 口径）同样是构造器表达不出来的。
 *
 * 三条约束：
 * 1. **输入只做绑定参数**：条件用 `Prisma.sql` 片段拼装，值一律走 `${}` 占位，不做字符串拼接；
 * 2. **数据范围条件由服务层解析成集合传进来**（`projectScopeWhere` 是全系统唯一一份范围判定，
 *    这里不再抄第二份 SQL 版规则）；
 * 3. **本层不判权限、不打码**——行原样出去，脱敏与降级展示归服务层。
 */

/** 榜单长度（§6.2 的 topPrototypes / topReferers 都是前十）。它是本文件的常量而不是入参，所以以字面量进 SQL（`Prisma.raw`）而不占绑定参数的位置。 */
const TOP_LIMIT = 10;
const TOP_LIMIT_SQL = Prisma.raw(String(TOP_LIMIT));

/** §6.1 明细行：日志自身的列 + 五个左连接带出来的展示列（snake_case 是 SQL 别名，Prisma 原样返回）。 */
export interface AccessLogRawRow {
  readonly id: bigint;
  readonly route_key: string;
  readonly path: string;
  readonly result: string;
  readonly user_id: bigint | null;
  readonly prototype_id: bigint | null;
  readonly prototype_name: null | string;
  readonly prototype_code: null | string;
  readonly prototype_deleted_at: Date | null;
  readonly project_id: bigint | null;
  readonly project_name: null | string;
  readonly project_deleted_at: Date | null;
  readonly version_no: number | null;
  readonly visitor_name: null | string;
  readonly ip: null | string;
  readonly ua: null | string;
  readonly browser: null | string;
  readonly os: null | string;
  readonly device: null | string;
  readonly referer: null | string;
  readonly is_bot: boolean;
  readonly created_at: Date;
}

/** §6.2 的五个指标（一次扫表全算出来，别让前端点一次卡片打五次库）。 */
export interface AccessLogAggregateRow {
  readonly bot_pv: bigint;
  readonly denied: bigint;
  readonly invalid_pv: bigint;
  readonly pv: bigint;
  readonly uv: bigint;
}

/** 按天分桶的 pv/uv；`day` 是 `date_trunc('day', …)` 的结果，标签由服务层按服务器本地日历日出。 */
export interface AccessLogDailyRow {
  readonly day: Date;
  readonly pv: bigint;
  readonly uv: bigint;
}

/** 按原型的榜：这里只有 id 与次数，名字要回 `proto_prototype` 取（拿不到名的行由服务层丢掉）。 */
export interface AccessLogPrototypeCountRow {
  readonly prototype_id: bigint;
  readonly pv: bigint;
}

/** 按来源的榜：`origin` 是 referer 的 `scheme://host[:port]` 部分。 */
export interface AccessLogRefererCountRow {
  readonly origin: null | string;
  readonly pv: bigint;
}

/**
 * 一条日志的归属判定输入（服务层解析好的集合）。
 *
 * `null` 与空集合的语义必须分清，否则"没筛"和"筛不到"会混成一件事：
 * - `scope = null` → `dataScope = all`，不加任何范围条件；
 * - `scope` 里的集合为空 → 这个人在范围内什么都没有，条件渲染成恒假（服务层其实已经提前返回空页，
 *   这里只是让"空集合"在 SQL 层也不可能是"不加过滤"）。
 */
export interface AccessLogConditions {
  /** IP / UA 模糊（§6.1 的 keyword） */
  readonly keyword: null | string;
  /** projectId 筛选解析出的该项目：编码 + 其下全部原型（含软删原型，见服务层注释） */
  readonly project: null | { readonly code: string; readonly prototypeIds: readonly bigint[] };
  readonly prototypeId: null | bigint;
  readonly result: null | string;
  readonly startAt: null | Date;
  readonly endAt: null | Date;
  readonly scope: null | {
    readonly projectCodes: readonly string[];
    readonly prototypeIds: readonly bigint[];
  };
}

/**
 * 原型连接：明细取名字、汇总判「无效链接」都要它，两处必须是同一条尺子，所以抽成常量。
 * `left join` 走 `proto_prototype` 主键且**不筛 `deleted_at`**：软删的原型也要连得出行，
 * 才分得开"编码从来没存在过"（`p.id` 为空）与"原型已删除"（`p.deleted_at` 非空）——
 * §6.1 把两者都显示成「无效链接」，机制 §6 把两者一起算进 `invalidPv`。
 */
const PROTOTYPE_JOIN = 'left join proto_prototype p on p.id = l.prototype_id';

/**
 * 明细查询的主体。`lateral` 而不是第二个 `left join`：项目编码上的唯一索引不覆盖软删行，直接 join 可能
 * 一行日志配出两个项目而把列表撑重。
 *
 * 用 `Prisma.raw` 包一层是必须的：`Prisma.sql` 模板把插进去的**字符串**当绑定参数，
 * 不包就会把整段 select 当成一个值发给数据库。这里是模块内的常量（无任何用户输入），
 * 所以内联是安全的——`REFERER_ORIGIN`/`TOP_LIMIT_SQL` 同理。
 */
const ROW_SELECT = Prisma.raw(`
  select
    l.id,
    l.route_key,
    l.path,
    l.result,
    l.user_id,
    l.prototype_id,
    l.ip,
    l.ua,
    l.browser,
    l.os,
    l.device,
    l.referer,
    l.is_bot,
    l.created_at,
    p.name as prototype_name,
    p.code as prototype_code,
    p.deleted_at as prototype_deleted_at,
    pj.id as project_id,
    pj.name as project_name,
    pj.deleted_at as project_deleted_at,
    r.version_no,
    u.username as visitor_name
  from proto_access_log l
  ${PROTOTYPE_JOIN}
  left join lateral (
    select pp.id, pp.name, pp.deleted_at
    from proto_project pp
    where pp.id = coalesce(
      p.project_id,
      (select pp2.id from proto_project pp2 where pp2.code = split_part(l.route_key, '/', 1) limit 1)
    )
    limit 1
  ) pj on true
  left join proto_release r on r.id = l.release_id
  left join sys_user u on u.id = l.user_id`);

/** referer 的 origin 段：正则只取 `scheme://host[:port]`，query 与 path 都进不了分组（§6.2 样例给的就是 origin）。 */
const REFERER_ORIGIN = Prisma.sql`(regexp_match(lower(l.referer), '^[a-z][a-z0-9+.-]*://[^/?#]+'))[1]`;

/**
 * LIKE 模式里的 `\` `%` `_` 必须转义：关键字是用户手输的 IP 片段，
 * 一个 `%` 不转义就会让"搜 10."命中全表，用户看到的是"搜索好像没生效"而不是错误。
 */
function toLikePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** 空集合的 `in ()` 是语法错误；"这一支一个都没有"要表达成恒假而不是被跳过。 */
function inAny(column: Prisma.Sql, values: readonly bigint[]): Prisma.Sql;
function inAny(column: Prisma.Sql, values: readonly string[]): Prisma.Sql;
function inAny(column: Prisma.Sql, values: readonly (string | bigint)[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`false`
    : Prisma.sql`${column} in (${Prisma.join(values)})`;
}

/** 范围/筛选条件 → where 片段（空条件返回 `Prisma.empty`，让 `… from l  group by 1` 这类尾巴保持合法）。 */
function whereClause(conditions: AccessLogConditions, extra: readonly Prisma.Sql[]): Prisma.Sql {
  const parts: Prisma.Sql[] = [];

  if (conditions.scope !== null) {
    parts.push(Prisma.sql`(
      ${inAny(Prisma.sql`l.prototype_id`, conditions.scope.prototypeIds)}
      or ${inAny(Prisma.sql`split_part(l.route_key, '/', 1)`, conditions.scope.projectCodes)}
    )`);
  }
  if (conditions.project !== null) {
    parts.push(Prisma.sql`(
      ${inAny(Prisma.sql`l.prototype_id`, conditions.project.prototypeIds)}
      or split_part(l.route_key, '/', 1) = ${conditions.project.code}
    )`);
  }
  if (conditions.prototypeId !== null) {
    parts.push(Prisma.sql`l.prototype_id = ${conditions.prototypeId}`);
  }
  if (conditions.result !== null) {
    parts.push(Prisma.sql`l.result = ${conditions.result}`);
  }
  if (conditions.startAt !== null) {
    parts.push(Prisma.sql`l.created_at >= ${conditions.startAt}`);
  }
  if (conditions.endAt !== null) {
    parts.push(Prisma.sql`l.created_at <= ${conditions.endAt}`);
  }
  if (conditions.keyword !== null) {
    const pattern = toLikePattern(conditions.keyword);
    // `ip` 是 inet：ilike 只吃文本，所以显式转 text；`ua` 本来就是 varchar。
    parts.push(Prisma.sql`(l.ip::text ilike ${pattern} or l.ua ilike ${pattern})`);
  }

  const all = [...parts, ...extra];
  return all.length === 0 ? Prisma.empty : Prisma.sql`where ${Prisma.join(all, ' and ')}`;
}

@Injectable()
export class AccessLogQueryRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /**
   * §6.1 明细分页。
   *
   * 排序固定 `created_at desc, id desc`：同一毫秒落库的多条日志（批量写缓冲 500 条一提交就是这种）
   * 没有第二把尺子就会翻页时重复/漏行，`id` 是自增的所以能当次序键（同 §7.5 的两张日志表）。
   * total 单独数一次：条件只落在 `l` 上，五个左连接都是"取展示名"用的，不影响命中行数，
   * 所以计数不需要背这些 join。
   */
  async findPage(
    conditions: AccessLogConditions,
    page: { readonly pageSize: number; readonly skip: number },
  ): Promise<{ readonly rows: AccessLogRawRow[]; readonly total: number }> {
    const where = whereClause(conditions, []);
    // 分页数字走 bigint：Postgres 的 limit/offset 只接受整数族参数，绑成浮点会直接报错。
    const limit = BigInt(page.pageSize);
    const offset = BigInt(page.skip);
    const [rows, counted] = await Promise.all([
      this.db.$queryRaw<Array<AccessLogRawRow>>(Prisma.sql`${ROW_SELECT}
        ${where}
        order by l.created_at desc, l.id desc
        limit ${limit} offset ${offset}`),
      this.db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        select count(*)::bigint as total
        from proto_access_log l
        ${where}`),
    ]);
    return { rows, total: Number(counted[0]?.total ?? 0n) };
  }

  /**
   * §6.2 的五个指标。一次扫表用 `filter (where …)` 分五个口径：
   * - `pv` = result=ok（机制 §6：只有入口访问写 ok）；
   * - `denied` = 401/403 两档合并成一个"被拦住"的数（界面只展示一个卡片）；
   * - `invalidPv` = not_found **且原型连不上或已软删**，单独统计是因为它升高意味着"有人拿旧链接在访问"（§6.2）；
   *   不加这半条就会把"原型活得好好的、只是发布产物里少了一个文件"那类资源 404（机制 §6 表倒数第二行，
   *   它自己也写 `not_found`）算进"无效链接访问"，同一屏上卡片与明细表就各说一套；
   * - `botPv` = ok 且 is_bot，与 pv 同集合的一个子集，所以两者能对上；
   * - `uv` = 按 (本地日, ip, ua) 去重，且**排除 bot**——机制 §6 说爬虫请求不进 UV。
   *   行构造器里的 null 也参与去重：匿名且没带 UA 的访问者在同一天只算一个人，这是 §6.2 口径的直接结果。
   */
  async aggregate(conditions: AccessLogConditions): Promise<AccessLogAggregateRow> {
    const rows = await this.db.$queryRaw<Array<AccessLogAggregateRow>>(Prisma.sql`
      select
        count(*) filter (where l.result = 'ok')::bigint as pv,
        count(*) filter (where l.result in ('denied_401', 'denied_403'))::bigint as denied,
        count(*) filter (where l.result = 'not_found' and (p.id is null or p.deleted_at is not null))::bigint as invalid_pv,
        count(*) filter (where l.result = 'ok' and l.is_bot)::bigint as bot_pv,
        count(distinct (date_trunc('day', l.created_at), l.ip, l.ua))
          filter (where l.result = 'ok' and not l.is_bot)::bigint as uv
      from proto_access_log l
      ${Prisma.raw(PROTOTYPE_JOIN)}
      ${whereClause(conditions, [])}`);
    const row = rows[0];
    // 聚合查询恒有一行；真没有就是驱动行为变了，宁可停下也不猜五个 0（§6.2 的卡片会显示"全 0 的正常平台"）。
    if (row === undefined) {
      throw new Error('访问记录汇总未返回结果');
    }
    return row;
  }

  /**
   * §6.2 的 `daily`。分桶粒度交给 `date_trunc('day', …)`，但**日历日标签由服务层按服务器本地时区出**：
   * 会话时区与进程时区不是同一个东西，若在这里就格式化成字符串，窗口（本地算）与桶（库算）会错一天，
   * 图上表现为"今天的数据挂到昨天"。所以这里只回 date 值，本地化留在一处。
   */
  async daily(conditions: AccessLogConditions): Promise<AccessLogDailyRow[]> {
    return this.db.$queryRaw<Array<AccessLogDailyRow>>(Prisma.sql`
      select
        date_trunc('day', l.created_at) as day,
        count(*) filter (where l.result = 'ok')::bigint as pv,
        count(distinct (l.ip, l.ua)) filter (where l.result = 'ok' and not l.is_bot)::bigint as uv
      from proto_access_log l
      ${whereClause(conditions, [])}
      group by 1
      order by 1`);
  }

  /**
   * §6.2 的 `topPrototypes`：按原型聚合取前十。
   * 只算 ok——榜单是"哪个原型被看得最多"，与 `pv` 同一个口径才不会被质疑"加起来为什么不等于总量"；
   * 不 ok 的行归 `invalidPv`/`denied`。`prototype_id` 为空的行（无效链接）在这里天然不进榜。
   */
  async topPrototypes(conditions: AccessLogConditions): Promise<AccessLogPrototypeCountRow[]> {
    return this.db.$queryRaw<Array<AccessLogPrototypeCountRow>>(Prisma.sql`
      select l.prototype_id, count(*)::bigint as pv
      from proto_access_log l
      ${whereClause(conditions, [Prisma.sql`l.result = 'ok'`, Prisma.sql`l.prototype_id is not null`])}
      group by l.prototype_id
      order by pv desc, l.prototype_id desc
      limit ${TOP_LIMIT_SQL}`);
  }

  /**
   * §6.2 的 `topReferers`：按 referer 的 origin 聚合取前十。
   * 空 referer 与解析不出 origin 的行不进榜（`origin is not null`）：前端那一列点开是"从哪儿来的链接"，
   * 一条空来源没有解释力，还会占掉一个名次。
   */
  async topReferers(conditions: AccessLogConditions): Promise<AccessLogRefererCountRow[]> {
    return this.db.$queryRaw<Array<AccessLogRefererCountRow>>(Prisma.sql`
      select ${REFERER_ORIGIN} as origin, count(*)::bigint as pv
      from proto_access_log l
      ${whereClause(conditions, [Prisma.sql`l.result = 'ok'`, Prisma.sql`${REFERER_ORIGIN} is not null`])}
      group by 1
      order by pv desc, origin
      limit ${TOP_LIMIT_SQL}`);
  }
}

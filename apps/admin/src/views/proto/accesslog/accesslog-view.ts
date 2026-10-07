import type { ECOption } from '@vben/plugins/echarts';

import type {
  AccessLogDailyPoint,
  AccessLogDevice,
  AccessLogItem,
  AccessLogListQuery,
  AccessLogResult,
  AccessLogSummary,
  AccessLogSummaryQuery,
} from '@protohub/shared';

import { ACCESS_LOG_RESULTS } from '@protohub/shared';

/**
 * 访问记录页（前端设计 §3.7；迭代实施计划 M4-T11）的呈现判定，全部是纯函数：
 * 「无效链接」降级、5 个指标卡的取数、筛选条 → 两个接口的参数装配、时间快捷 → 窗口换算。
 * 页面与子组件只消费这里的结论，单测（accesslog-view.spec.ts）断言的也是这一层的行为。
 */

/** 时间快捷（§3.7：今天/近 7 天/近 30 天/自定义）。 */
export const ACCESS_LOG_TIME_PRESETS = [
  'custom',
  'month',
  'today',
  'week',
] as const;
export type AccessLogTimePreset = (typeof ACCESS_LOG_TIME_PRESETS)[number];

export function isAccessLogTimePreset(value: unknown): value is AccessLogTimePreset {
  return (
    typeof value === 'string' &&
    (ACCESS_LOG_TIME_PRESETS as readonly string[]).includes(value)
  );
}

export function isAccessLogResult(value: unknown): value is AccessLogResult {
  return (
    typeof value === 'string' &&
    (ACCESS_LOG_RESULTS as readonly string[]).includes(value)
  );
}

/**
 * 与后端 access-log.query.service.ts 的同名常量对齐（days 夹取 1..90）。
 * 后端也会夹取；这里夹同一区间是为了"卡片标题里的 N 天"与实际请求的 days 是同一个数。
 */
export const ACCESS_LOG_SUMMARY_MIN_DAYS = 1;
export const ACCESS_LOG_SUMMARY_MAX_DAYS = 90;

/** 筛选条的一次生效快照：三个区块（指标卡 / 趋势 / 明细表）共用这同一份参数。 */
export interface AppliedAccessLogFilters {
  endTime?: string;
  keyword?: string;
  projectId?: string;
  prototypeId?: string;
  result?: AccessLogResult;
  startTime?: string;
}

/** 项目/原型两级范围（用 type 而非 interface：作为路由 query 传给 vue-router 需要隐式索引签名）。 */
export type AccessLogScope = {
  projectId?: string;
  prototypeId?: string;
};

// -----------------------------------------------------------------------------
// 时间窗口
// -----------------------------------------------------------------------------

/** 本地日始/日终：窗口按日历日算（与后端 buildSummaryWindow 的"含今天的 N 个日历日"同尺子）。 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** 用 setDate 而不是加毫秒：跨夏令时那天真的不是 24 小时（后端窗口注释同理）。 */
function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** 快捷项换算成 ISO 区间（§6.1 的 startTime/endTime）；自定义未选区间 = 不加时间条件。 */
export function resolveTimeWindow(
  preset: AccessLogTimePreset,
  customRange: [Date, Date] | null,
  now: Date = new Date(),
): { endTime?: string; startTime?: string } {
  switch (preset) {
    case 'custom': {
      if (customRange === null) {
        return {};
      }
      const [start, end] = customRange;
      return {
        endTime: endOfDay(end).toISOString(),
        startTime: startOfDay(start).toISOString(),
      };
    }
    case 'month': {
      return {
        endTime: endOfDay(now).toISOString(),
        startTime: startOfDay(addDays(now, -29)).toISOString(),
      };
    }
    case 'today': {
      return {
        endTime: endOfDay(now).toISOString(),
        startTime: startOfDay(now).toISOString(),
      };
    }
    case 'week': {
      return {
        endTime: endOfDay(now).toISOString(),
        startTime: startOfDay(addDays(now, -6)).toISOString(),
      };
    }
  }
}

/**
 * 由列表窗口反推 summary 的 `days`：后端 §6.2 只有"最近 N 个日历日（含今天）"这一维（没有 endTime），
 * 取"窗口起点 → 今天"的天数，让指标卡/折线的下界与明细表的下界对齐。
 * 上界对不齐（自定义区间止于过去时 summary 会多看几天）是后端参数形态的限制，见计划 §9.2 DEV-36。
 */
export function resolveSummaryDays(
  window: { endTime?: string; startTime?: string },
  now: Date = new Date(),
): number | undefined {
  if (window.startTime === undefined) {
    // 不传 days：服务端默认 7（resolveSummaryDays 同源），前端不替它决定
    return undefined;
  }
  const start = startOfDay(new Date(window.startTime));
  const today = startOfDay(now);
  const diffDays = Math.round((today.getTime() - start.getTime()) / 86_400_000);
  const days = diffDays + 1;
  return Math.min(Math.max(days, ACCESS_LOG_SUMMARY_MIN_DAYS), ACCESS_LOG_SUMMARY_MAX_DAYS);
}

// -----------------------------------------------------------------------------
// 参数装配（明细列表 / 汇总各一份，都只读同一份 AppliedAccessLogFilters）
// -----------------------------------------------------------------------------

/**
 * 明细查询参数。刻意不写 `maskIp`：缺省即服务端默认打码（§6.1），
 * 前端任何时候都不发 `maskIp=false`（明文入口不在本期，accesslog-view.spec.ts 钉住这一条）。
 */
export function buildListQuery(
  filters: AppliedAccessLogFilters,
  page: { pageNumber: number; pageSize: number },
): AccessLogListQuery {
  // keyword 的归一只在这一步：空白串不发服务端（否则等于"按空格模糊"，是没人想要的筛选）
  const keyword = filters.keyword?.trim();
  return {
    endTime: filters.endTime,
    keyword: keyword === '' ? undefined : keyword,
    page: page.pageNumber,
    pageSize: page.pageSize,
    projectId: filters.projectId,
    prototypeId: filters.prototypeId,
    result: filters.result,
    startTime: filters.startTime,
  };
}

export function buildSummaryQuery(
  filters: AppliedAccessLogFilters,
  now: Date = new Date(),
): AccessLogSummaryQuery {
  const days = resolveSummaryDays(
    { endTime: filters.endTime, startTime: filters.startTime },
    now,
  );
  return {
    days,
    projectId: filters.projectId,
    prototypeId: filters.prototypeId,
  };
}

/**
 * URL query → 初始范围（M4-T12 从项目/原型详情带 `projectId`/`prototypeId` 跳入）。
 * 只认这两个键、只收非空字符串——其余参数（比如分享链接带上的脏值）一律忽略而不是转成筛选。
 */
export function initialScopeFromQuery(query: Record<string, unknown>): AccessLogScope {
  const readId = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const scope: AccessLogScope = {};
  const projectId = readId(query.projectId);
  const prototypeId = readId(query.prototypeId);
  if (projectId !== undefined) {
    scope.projectId = projectId;
  }
  if (prototypeId !== undefined) {
    scope.prototypeId = prototypeId;
  }
  return scope;
}

/**
 * 访问记录页的路由路径（前端设计 §4）。详情页的指标跳转、折叠区的「查看更多」与本页
 * 都读这一枚常量——同一个路径字面量散在三处，改路由时漏一处就是一个死链。
 */
export const ACCESS_LOG_ROUTE_PATH = '/proto/accesslog';

/**
 * 范围 → 跳转 query：`initialScopeFromQuery` 的反函数，只发它认得的那两个键。
 * "带过去的"和"接得住的"由同一模块的一对函数定义，跳转参数就不可能和解析器对不上。
 */
export function buildAccessLogJumpQuery(scope: AccessLogScope): AccessLogScope {
  const query: AccessLogScope = {};
  const projectId = scope.projectId?.trim();
  const prototypeId = scope.prototypeId?.trim();
  if (projectId !== undefined && projectId !== '') {
    query.projectId = projectId;
  }
  if (prototypeId !== undefined && prototypeId !== '') {
    query.prototypeId = prototypeId;
  }
  return query;
}

/** 两个范围是否等价（undefined 与缺失视为相同）：route.query 每次导航都是新对象，靠它滤掉"参数没变"的重查。 */
export function accessLogScopeEquals(prev: AccessLogScope, next: AccessLogScope): boolean {
  return (
    (prev.projectId ?? undefined) === (next.projectId ?? undefined) &&
    (prev.prototypeId ?? undefined) === (next.prototypeId ?? undefined)
  );
}

/**
 * 「近 7 天访问量」是否可点：详情接口把 `visitsLast7d` 定成 `number`，但缺值（null/undefined）时
 * 不该渲染成一个指向空筛选的死链——这一判定同时被项目/原型两个详情页用，收在此处。
 */
export function isVisitsMetricClickable(value: null | number | undefined): boolean {
  return value !== null && value !== undefined;
}

// -----------------------------------------------------------------------------
// 单元格 / 卡片判定
// -----------------------------------------------------------------------------

/**
 * 「原型」列的降级判定（M4-T11 判据）：`prototypeName` 为空且还有 `routeKey` 时，
 * 该行渲染成灰色「无效链接」+ `routeKey` 副标题（§6.1：编码不存在/原型已删时三个名字字段都是 null）。
 */
export interface AccessLogPrototypeCellModel {
  invalid: boolean;
  /** 无效链接时的副标题（形如 crm/crm-p01）；正常行为 null */
  routeKey: null | string;
  /** 正常行的原型名；无效链接与"什么都取不到"时为 null */
  title: null | string;
}

export function prototypeCellOf(
  row: Pick<AccessLogItem, 'prototypeName' | 'routeKey'>,
): AccessLogPrototypeCellModel {
  const name = row.prototypeName;
  if (name !== null && name !== '') {
    return { invalid: false, routeKey: null, title: name };
  }
  if (row.routeKey !== '') {
    return { invalid: true, routeKey: row.routeKey, title: null };
  }
  return { invalid: false, routeKey: null, title: null };
}

/** 结果 Tag：ok=绿、401/403=警示色系、404=红（前端设计 §3.7 的四种语义）。 */
export const ACCESS_LOG_RESULT_TAG_COLORS: Record<AccessLogResult, string> = {
  denied_401: 'orange',
  denied_403: 'volcano',
  not_found: 'red',
  ok: 'green',
};

export interface AccessLogResultTagModel {
  color: string;
  labelKey: string;
}

export function resultTagOf(result: AccessLogResult): AccessLogResultTagModel {
  return {
    color: ACCESS_LOG_RESULT_TAG_COLORS[result],
    labelKey: `proto.accesslog.results.${result}`,
  };
}

export function deviceLabelKey(device: AccessLogDevice): string {
  return `proto.accesslog.devices.${device}`;
}

/** 5 个指标卡的取数（§3.7：PV/UV/被拒/爬虫/无效链接）。值一律直读 summary 字段，前端不加工、不加解释文案（口径只在服务端）。 */
export const ACCESS_LOG_METRIC_KEYS = [
  'pv',
  'uv',
  'denied',
  'botPv',
  'invalidPv',
] as const;
export type AccessLogMetricKey = (typeof ACCESS_LOG_METRIC_KEYS)[number];

export interface AccessLogMetricCardModel {
  key: AccessLogMetricKey;
  labelKey: string;
  value: number;
}

export function summaryMetricCards(summary: AccessLogSummary): AccessLogMetricCardModel[] {
  return ACCESS_LOG_METRIC_KEYS.map((key) => ({
    key,
    labelKey: `proto.accesslog.metrics.${key}`,
    value: summary[key],
  }));
}

// -----------------------------------------------------------------------------
// 趋势图（§3.7：近 N 天 PV/UV 双折线，echarts 走 @vben/plugins/echarts 的按需预置，不新增依赖）
// -----------------------------------------------------------------------------

export interface AccessLogTrendLabels {
  pv: string;
  uv: string;
}

/** 折线 option：x 轴直接用服务端的日历日标签（fillDaily 已补零值日，图上不会"连掉"空白天）。 */
export function buildTrendOption(daily: AccessLogDailyPoint[], labels: AccessLogTrendLabels): ECOption {
  const dates = daily.map((point) => point.date);
  return {
    grid: { left: 48, right: 24, top: 40, bottom: 32 },
    // 默认图例落 bottom 压在 x 轴日期上；grid.top=40 已经给顶部留了位
    legend: { data: [labels.pv, labels.uv], left: 'center', top: 0 },
    series: [
      {
        data: daily.map((point) => point.pv),
        name: labels.pv,
        smooth: true,
        type: 'line' as const,
      },
      {
        data: daily.map((point) => point.uv),
        name: labels.uv,
        smooth: true,
        type: 'line' as const,
      },
    ],
    tooltip: { trigger: 'axis' as const },
    xAxis: { boundaryGap: false, data: dates, type: 'category' as const },
    yAxis: { minInterval: 1, type: 'value' as const },
  };
}

/**
 * 时间列的单元格分两行（与项目列表「最近更新」列一个样式）；formatDateTime 的输出在这里拆。
 * 传入已格式化的文本，保持本模块不依赖 @vben/utils（可单测）。
 */
export function splitDateTime(formatted: string): { date: string; time: string } {
  const [date = '', time = ''] = formatted.split(' ');
  return { date, time };
}

/**
 * 「浏览器/系统/设备」列的次级行（os · 设备档位）——访问记录明细表与原型详情的访问记录折叠区
 * 都要这一句，收在此处只写一遍（§3.7）。翻译由调用方注入，本模块维持 i18n 无关、可单测。
 */
export function accessLogEnvSubText(
  row: Pick<AccessLogItem, 'device' | 'os'>,
  translate: (key: string) => string,
): string {
  const parts = [row.os, row.device ? translate(deviceLabelKey(row.device)) : null];
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

// -----------------------------------------------------------------------------
// 原型详情「访问记录」折叠区（前端设计 §3.5 / 迭代实施计划 M4-T12）
// -----------------------------------------------------------------------------

/** 折叠区只取最近 N 条访问（§6.1 没有"是否入口"这一维，见计划 §9.2 DEV-36）；"更多"是跳转而不是分页。 */
export const ACCESS_LOG_PANEL_LIMIT = 20;

/**
 * 折叠区一行的呈现模型。刻意复用明细表那套判定（`resultTagOf` 给颜色+文案 key、
 * `accessLogEnvSubText` 组浏览器/系统/设备、`splitDateTime` 拆时间），页面不重算第二套——
 * 否则同一行在两个页面上会给出两种结论。
 * 不带「原型」/无效链接列：本区按 `prototypeId` 筛（§6.1），而无效链接行的 `prototype_id`
 * 为空、根本进不来这一集合（它们只在访问记录页按 `routeKey` 呈现）。
 */
export interface AccessLogPanelRow {
  browser: null | string;
  envSub: string;
  id: string;
  /** 服务端已按 §6.1 打码的 IP；null 时页面落占位 */
  ip: null | string;
  path: string;
  result: AccessLogResultTagModel;
  time: { date: string; time: string };
  visitorName: null | string;
}

/**
 * 把原始访问行映射成折叠区要显示的每一格。`formatTime` / `translate` 由页面注入
 * （`formatDateTime` 与 `$t`），让这层保持纯函数、可在单测里用假实现断言行为。
 */
export function toAccessLogPanelRows(
  items: AccessLogItem[],
  deps: { formatTime: (value: string) => string; translate: (key: string) => string },
): AccessLogPanelRow[] {
  return items.map((item) => ({
    browser: item.browser,
    envSub: accessLogEnvSubText(item, deps.translate),
    id: item.id,
    ip: item.ip,
    path: item.path,
    result: resultTagOf(item.result),
    time: splitDateTime(deps.formatTime(item.createdAt)),
    visitorName: item.visitorName,
  }));
}

import type { DashboardOverview, VisitStats } from '@protohub/shared';

import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';

/**
 * 工作台（前端设计 §3.1；迭代实施计划 M5-T1）的呈现判定，全部是纯函数：
 * 四张统计卡各取哪个字段、环比怎么算、相对时间怎么出。页面只消费这里的结论，
 * 单测（workspace-view.spec.ts）钉的也是这一层的行为。
 */
dayjs.extend(relativeTime);

export interface VisitDelta {
  /** 环比百分比（整数）；`previous7d = 0` 时为 null——0 基准没有可比性，不显示百分比（计划 §9.2 DEV-38） */
  percent: null | number;
  previous7d: number;
}

/** 环比 = (last7d - previous7d) / previous7d，两个窗口都按服务器本地日历日（后端接口设计 §3.1） */
export function visitDeltaOf(stats: Pick<VisitStats, 'last7d' | 'previous7d'>): VisitDelta {
  const { last7d, previous7d } = stats;
  return {
    percent:
      previous7d > 0 ? Math.round(((last7d - previous7d) / previous7d) * 100) : null,
    previous7d,
  };
}

/** 带符号的百分比：+12% / -3% / 0% */
export function signedPercent(percent: number): string {
  return `${percent > 0 ? '+' : ''}${String(percent)}%`;
}

/** 相对时间（§3.1「相对时间」）：几小时前、几天前；`now` 可注入以便单测 */
export function relativeTimeOf(iso: string, now?: dayjs.ConfigType): string {
  return dayjs(iso).from(now === undefined ? dayjs() : dayjs(now));
}

export interface WorkspaceStatCard {
  /** 只有「近 7 天访问量」带环比（§3.1），其余卡不带 */
  delta: null | VisitDelta;
  key: 'projects' | 'prototypes' | 'releases' | 'visits';
  labelKey: string;
  /** 还没取到数时是 `null`（显示"—"），不是 0——0 是"查过了没有"，`null` 是"没数" */
  value: null | number;
}

/**
 * 四张统计卡（§3.1：项目数 / 原型数 / 本周发布次数 / 近 7 天访问量）。
 * 数字原样直读 overview 的字段：项目与原型取 `total`（注意是原型数，不是"已发布项目数"），
 * 发布次数取 `thisWeek`（口径见计划 §9.2 DEV-38），访问量取 `last7d`。
 * 还没取到数（加载中 / 请求失败）也照样给四张卡的骨架，只是值为 `null`。
 */
export function workspaceStatCards(
  overview: DashboardOverview | null,
): WorkspaceStatCard[] {
  return [
    {
      delta: null,
      key: 'projects',
      labelKey: 'proto.workspace.stats.projects',
      value: overview?.projectStats.total ?? null,
    },
    {
      delta: null,
      key: 'prototypes',
      labelKey: 'proto.workspace.stats.prototypes',
      value: overview?.prototypeStats.total ?? null,
    },
    {
      delta: null,
      key: 'releases',
      labelKey: 'proto.workspace.stats.releases',
      value: overview?.releaseStats.thisWeek ?? null,
    },
    {
      delta: overview === null ? null : visitDeltaOf(overview.visitStats),
      key: 'visits',
      labelKey: 'proto.workspace.stats.visits',
      value: overview?.visitStats.last7d ?? null,
    },
  ];
}

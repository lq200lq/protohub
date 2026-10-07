import type { PrototypeStatus, ReleaseEventType } from '../enums';

/** 项目/原型的状态计数；项目的 status 是派生值（决策 D-22） */
export interface StatusStats {
  archived: number;
  draft: number;
  published: number;
  total: number;
}

export interface ReleaseStats {
  thisWeek: number;
  today: number;
}

export interface VisitStats {
  deniedLast7d: number;
  last7d: number;
  /** 上一个 7 天窗口的入口访问量，供前端设计 §3.1「近 7 天访问量（含环比小字）」算差值（计划 §9.2 DEV-38）。 */
  previous7d: number;
  today: number;
  uvLast7d: number;
}

/** 工作台"最近更新的原型"行（§3.1）：取最近更新的 5 个原型，不是项目 */
export interface RecentPrototypeItem {
  accessUrl: string;
  code: string;
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  status: PrototypeStatus;
  updatedAt: string;
  visitsLast7d: number;
}

export interface RecentEventItem {
  createdAt: string;
  eventType: ReleaseEventType;
  id: string;
  operatorName: string;
  projectName: string;
  prototypeCode: string;
  prototypeName: string;
  reason: null | string;
}

/** GET /api/dashboard/overview；全部数字受数据权限过滤 */
export interface DashboardOverview {
  projectStats: StatusStats;
  prototypeStats: StatusStats;
  recentEvents: RecentEventItem[];
  recentPrototypes: RecentPrototypeItem[];
  releaseStats: ReleaseStats;
  visitStats: VisitStats;
}

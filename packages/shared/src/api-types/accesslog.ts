import type {
  AccessGateCode,
  AccessLogDevice,
  AccessLogResult,
  AccessReason,
} from '../enums';
import type { PageQuery } from './common';

/** GET /api/access-logs 查询（§6.1）；maskIp=false 需 system:log:list 以上 */
export interface AccessLogListQuery extends PageQuery {
  endTime?: string;
  /** IP / UA 模糊 */
  keyword?: string;
  maskIp?: boolean;
  projectId?: string;
  prototypeId?: string;
  result?: AccessLogResult;
  startTime?: string;
}

/**
 * 访问记录行（§6.1）。prototypeId/Name/Code 在编码不存在或原型已删时为 null，
 * 此时只有 routeKey 能说明访问的是哪条路径，列表页显示为「无效链接」。
 */
export interface AccessLogItem {
  browser: null | string;
  createdAt: string;
  device: AccessLogDevice | null;
  id: string;
  ip: null | string;
  isBot: boolean;
  os: null | string;
  path: string;
  projectId: null | string;
  projectName: null | string;
  prototypeCode: null | string;
  prototypeId: null | string;
  prototypeName: null | string;
  referer: null | string;
  result: AccessLogResult;
  /** 形如 crm/crm-p01 */
  routeKey: string;
  userId: null | string;
  versionNo: null | number;
  visitorName: null | string;
}

/** GET /api/access-logs/summary 查询（§6.2）；days 默认 7、上限 90 */
export interface AccessLogSummaryQuery {
  days?: number;
  projectId?: string;
  prototypeId?: string;
}

export interface AccessLogDailyPoint {
  date: string;
  pv: number;
  uv: number;
}

export interface AccessLogTopPrototype {
  code: string;
  name: string;
  projectName: string;
  prototypeId: string;
  pv: number;
}

export interface AccessLogTopReferer {
  pv: number;
  referer: string;
}

/** invalidPv 是访问不存在/已删编码的次数：异常升高说明有人还在用旧链接 */
export interface AccessLogSummary {
  botPv: number;
  daily: AccessLogDailyPoint[];
  denied: number;
  invalidPv: number;
  pv: number;
  topPrototypes: AccessLogTopPrototype[];
  topReferers: AccessLogTopReferer[];
  uv: number;
}

/** POST /api/access/{projectCode}/{prototypeCode}/unlock（§9.2） */
export interface UnlockAccessParams {
  password: string;
}

/** GET /api/access/gate 查询（§9.3），由 nginx error_page 代理传入 */
export interface GateQueryParams {
  code: AccessGateCode;
  /** 原始路径，用于登录后跳回 */
  from?: string;
  project: string;
  prototype?: string;
  reason?: AccessReason;
}

/**
 * /api/access/check 的决策结果（原型发布与访问机制 §5.1）。
 * releaseDir 形如 releases/{projectId}/{prototypeId}/{releaseId}，nginx 侧按形状白名单取用。
 */
export interface AccessDecision {
  reason?: AccessReason;
  releaseDir?: string;
  status: 200 | 401 | 403 | 404;
}

export const ACCESS_RELEASE_DIR_HEADER = 'X-Proto-Release-Dir';
export const ACCESS_REASON_HEADER = 'X-Proto-Reason';
export const ORIGINAL_URI_HEADER = 'X-Original-URI';
export const REAL_IP_HEADER = 'X-Real-IP';
export const TRACE_ID_HEADER = 'X-Trace-Id';

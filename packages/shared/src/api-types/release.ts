import type {
  UploadTaskErrorCode,
  UploadWarningCode,
} from '../constants/error-codes';
import type {
  ReleaseEventType,
  ReleaseStatus,
  UploadTaskStage,
  UploadTaskStatus,
} from '../enums';
import type { PageQuery } from './common';
import type { PrototypeDetail } from './prototype';

/** POST /api/releases 受理成功（HTTP 202）；后续进度靠 taskId 轮询 §5.3 */
export interface ReleaseAcceptedResult {
  accessPath: string;
  projectId: string;
  prototypeId: string;
  taskId: string;
}

/** multipart 表单里 project/prototype 两个 JSON 字段的形态（§5.1） */
export interface ReleaseUploadRefPayload {
  code?: string;
  description?: string;
  name: string;
}

/** POST /api/releases 的非文件字段；file 与 Idempotency-Key 走 FormData/Header 本身 */
export interface ReleaseUploadForm {
  /** 内容与当前版本一致时是否强制发布，默认 false */
  force?: boolean;
  note?: string;
  project?: ReleaseUploadRefPayload;
  projectId?: string;
  prototype?: ReleaseUploadRefPayload;
  prototypeId?: string;
}

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** GET /api/releases/link-preview 的查询参数（两段编码都得已确定：手填值或 check-code 的 generated） */
export interface ReleaseLinkPreviewQuery {
  projectCode: string;
  prototypeCode: string;
}

/**
 * 发布前的链接预览。前端要显示"发布后访问链接"这一整条 URL，而域名的拼装权在服务端
 * （§4.3 的 `accessUrl` 口径 + 接口设计 line「不要在多个前端页面里各写一遍域名拼接」），
 * 所以这里交两段编码换最终链接，URL 的拼装只留服务端一处。
 */
export interface ReleaseLinkPreviewResult {
  accessPath: string;
  accessUrl: string;
}

/** 发布成功后的版本快照（§5.3 release 字段） */
export interface ReleaseSummary {
  accessPath: string;
  accessUrl: string;
  contentHash: string;
  entryFile: string;
  fileCount: number;
  id: string;
  projectId: string;
  prototypeId: string;
  publishedAt: string;
  totalBytes: number;
  versionNo: number;
}

/** 版本列表行（§5.4）；versionNo 是原型内序号，跨原型互不影响 */
export interface ReleaseListItem {
  createdAt: string;
  createdByName: string;
  entryFile: string;
  fileCount: number;
  id: string;
  isCurrent: boolean;
  note: null | string;
  /**
   * 这一版的发布报告（前端设计 §3.5「点某条展开该版本的发布报告」）。
   *
   * 来自 `proto_release.manifest.warnings`（机制 §2.7 落库时就带着），不是任务行的副本——
   * 任务行会按 §1.5 被回收，而发布报告是版本的长期属性。人话文案由服务端生成，
   * 界面原样显示（§8.2），不再在前端重算一遍。
   */
  report: UploadTaskWarning[];
  /**
   * 原始包文件名，来自受理时那条任务行（`proto_release` 上没有这一列）。
   * 任务被 GC 回收后就没有来源了，按 §1.5 回 null 而不是空串。
   */
  sourceName: null | string;
  sourceSize: number;
  status: ReleaseStatus;
  totalBytes: number;
  versionNo: number;
  warnings: ReleaseRewriteWarnings;
}

/** proto_release.manifest.rewrites 的前端展示口径（§2.6 发布报告） */
export interface ReleaseRewriteWarnings {
  cssRewrites: number;
  htmlRewrites: number;
}

/** 版本列表分页参数：除 page/pageSize/sort 外无业务筛选（原型由路径 {id} 决定） */
export type ReleaseListQuery = PageQuery;

/** POST /api/prototypes/{id}/rollback：回滚只影响这一条链接 */
export interface RollbackParams {
  reason?: string;
  releaseId: string;
}

export type RollbackResult = PrototypeDetail;

/** 任务与版本报告里的改写/跳过提示（§5.3 warnings） */
export interface UploadTaskWarning {
  code: UploadWarningCode;
  count?: number;
  message: string;
}

/**
 * §5.3 的失败详情。`message` 就是任务行 `error_message` 里那句"下一步做什么"的话
 * （原型发布与访问机制 §8.2：界面直接读，不再在前端重算文案）。
 */
export interface UploadTaskError {
  errorCode: UploadTaskErrorCode;
  message: string;
}

/** GET /api/upload-tasks/{id} 轮询返回（§5.3） */
export interface UploadTaskStatusResult {
  error: null | UploadTaskError;
  /** 0-100，阶段区间见原型发布与访问机制 §2.1 */
  progress: number;
  projectId: string;
  prototypeId: string;
  release: null | ReleaseSummary;
  sourceName: string;
  sourceSize: number;
  stage: null | UploadTaskStage;
  status: UploadTaskStatus;
  taskId: string;
  warnings: UploadTaskWarning[];
}

/** GET /api/prototypes/{id}/events（§5.8） */
export interface ReleaseEventItem {
  createdAt: string;
  eventType: ReleaseEventType;
  fromVersionNo: null | number;
  id: string;
  operatorName: string;
  reason: null | string;
  toVersionNo: null | number;
}

export type ReleaseEventListQuery = PageQuery;

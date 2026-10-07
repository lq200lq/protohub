import type { AccessMode, PrototypeStatus } from '../enums';
import type { PageQuery } from './common';

/** 原型当前生效版本的摘要（列表与详情共用） */
export interface CurrentReleaseSummary {
  fileCount: number;
  id: string;
  publishedAt: string;
  publishedByName: string;
  totalBytes: number;
  versionNo: number;
}

/** 原型列表行（§4.3）；accessUrl 由服务端用 PUBLIC_BASE_URL 拼好，前端不再各自拼域名 */
export interface PrototypeListItem {
  accessMode: AccessMode;
  /** 相对路径，形如 /p/{项目码}/{原型码} */
  accessPath: string;
  accessUrl: string;
  code: string;
  createdAt: string;
  currentRelease: CurrentReleaseSummary | null;
  description: null | string;
  id: string;
  name: string;
  projectId: string;
  releaseCount: number;
  sort: number;
  status: PrototypeStatus;
  updatedAt: string;
  visitsLast7d: number;
}

/** 原型详情（§4.3.4）：策略字段平铺在详情里，避免与列表的 accessMode 形成两份真相 */
export interface PrototypeDetail extends PrototypeListItem {
  archivedAt: null | string;
  currentReleaseId: null | string;
  firstPublishedAt: null | string;
  /** 访问密码是否已设置；哈希永不出前端 */
  hasAccessPassword: boolean;
  /** 谁能通过 member 档访问：父项目成员（权限模型 §6.2 原型不单独判范围）；只读展示 */
  memberIds: string[];
  /** 改模式/改密码会 +1，该原型旧解锁 Cookie 立即失效（D-07） */
  policyVersion: number;
  publishedAt: null | string;
}

/** GET /api/prototypes 必须带 projectId（§4.3.1） */
export interface PrototypeListQuery extends PageQuery {
  keyword?: string;
  projectId: string;
  status?: PrototypeStatus;
}

export interface CreatePrototypeParams {
  code?: string;
  description?: string;
  name: string;
  projectId: string;
}

/** PUT /api/prototypes/{id}：code 不可改（§4.3.5），传了按忽略处理并回警告码 */
export interface UpdatePrototypeParams {
  description?: string;
  name: string;
  sort?: number;
}

/** 更新接口的响应 = 最新详情 + 被忽略字段的警告码 */
export interface PrototypeUpdateResult extends PrototypeDetail {
  warnings: string[];
}

/**
 * PUT /api/prototypes/{id}/policy；password 省略即沿用旧密码。
 *
 * 没有 `memberIds`：member 档的可访问人就是**父项目成员**（权限模型 §6.2 原型不单独判数据权限），
 * 库里没有原型级成员表，写它无处落（迭代实施计划 §9 偏差 DEV-9）。
 */
export interface UpdatePrototypePolicyParams {
  accessMode: AccessMode;
  password?: string;
}

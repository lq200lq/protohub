import type { CodeCheckReason, MemberRole, ProjectStatus } from '../enums';
import type { PageQuery } from './common';
import type { ReleaseEventItem } from './release';

/** 项目列表行；status 是由其下原型聚合出的派生值，不落库（决策 D-22） */
export interface ProjectListItem {
  code: string;
  createdByName: string;
  description: null | string;
  id: string;
  lastPublishedAt: null | string;
  name: string;
  prototypeCount: number;
  publishedCount: number;
  status: ProjectStatus;
  updatedAt: string;
  visitsLast7d: number;
}

export interface ProjectPrototypeCounts {
  archived: number;
  draft: number;
  published: number;
  total: number;
}

/** 项目详情（§4.1.4）：prototypeCount 在此处是明细对象，列表里是数字 */
export interface ProjectDetail extends Omit<ProjectListItem, 'prototypeCount'> {
  archivedAt: null | string;
  /** 前端设计 §3.3「基本信息」要"创建时间"；列表行不放（§3.2 的列定义里没有它） */
  createdAt: string;
  memberCount: number;
  prototypeCount: ProjectPrototypeCounts;
}

export interface ProjectListQuery extends PageQuery {
  keyword?: string;
  status?: ProjectStatus;
}

/** POST /api/projects：code 省略即服务端自动生成 */
export interface CreateProjectParams {
  code?: string;
  description?: string;
  name: string;
}

/** PUT /api/projects/{id}：传 code 不生效，服务端返回 PROTO_CODE_IMMUTABLE 警告 */
export interface UpdateProjectParams {
  description?: string;
  name: string;
}

/** 更新接口的响应 = 最新详情 + 被忽略字段的警告码（§4.1.5「传了也不生效」的落点） */
export interface ProjectUpdateResult extends ProjectDetail {
  warnings: string[];
}

/** GET /api/projects/check-code 与 /api/prototypes/check-code 共用（§4.2） */
export interface CodeCheckResult {
  available: boolean;
  /** code 留空时告诉前端"将生成这个" */
  generated?: string;
  message?: string;
  reason?: CodeCheckReason;
  /** 已被占用时给的备选编码 */
  suggestion?: string;
}

export interface ProjectMemberItem {
  createdAt: string;
  /** 一期只记录与展示，不参与鉴权（权限模型设计 §6.2） */
  memberRole: MemberRole;
  realName: string;
  userId: string;
  username: string;
}

export interface ProjectMemberInput {
  memberRole?: MemberRole;
  userId: string;
}

/** PUT /api/projects/{id}/members：覆盖式 */
export interface SetProjectMembersParams {
  members: ProjectMemberInput[];
}

/**
 * GET /api/projects/{id}/events：项目级动态是原型事件加两级信息（§5.8）。
 * 两条都非空：`prototype_id` 是 NOT NULL 外键，而查询把软删原型的事件一并排除了，
 * 留个 `null` 只会让前端为一条不可能出现的记录写分支。
 */
export interface ProjectEventItem extends ReleaseEventItem {
  prototypeCode: string;
  prototypeName: string;
}

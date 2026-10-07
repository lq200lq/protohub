/** 取值来自数据库设计 §4 的 CHECK 约束：数组供 seed/运行时校验，联合类型供两端编译期约束 */

export const PROJECT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROTOTYPE_STATUSES = ['draft', 'published', 'archived'] as const;
export type PrototypeStatus = (typeof PROTOTYPE_STATUSES)[number];

export const RELEASE_STATUSES = ['ready', 'broken', 'deleted'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const ACCESS_MODES = ['public', 'password', 'member'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const UPLOAD_TASK_STATUSES = [
  'pending',
  'processing',
  'success',
  'failed',
  'canceled',
] as const;
export type UploadTaskStatus = (typeof UPLOAD_TASK_STATUSES)[number];

export const UPLOAD_TASK_STAGES = [
  'validating',
  'extracting',
  'postprocess',
  'committing',
] as const;
export type UploadTaskStage = (typeof UPLOAD_TASK_STAGES)[number];

export const RELEASE_EVENT_TYPES = [
  'publish',
  'rollback',
  'republish',
  'unpublish',
  'delete_version',
] as const;
export type ReleaseEventType = (typeof RELEASE_EVENT_TYPES)[number];

export const ACCESS_LOG_RESULTS = [
  'ok',
  'denied_401',
  'denied_403',
  'not_found',
] as const;
export type AccessLogResult = (typeof ACCESS_LOG_RESULTS)[number];

/** `/api/access/check` 的 X-Proto-Reason 取值（后端接口设计 §9.1） */
export const ACCESS_REASONS = [
  'NEED_PASSWORD',
  'NEED_LOGIN',
  'NO_PERMISSION',
  'PROTOTYPE_ARCHIVED',
  'PROJECT_ARCHIVED',
  'NOT_FOUND',
  'NOT_PUBLISHED',
] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];

export const ACCESS_GATE_CODES = ['401', '403', '404'] as const;
export type AccessGateCode = (typeof ACCESS_GATE_CODES)[number];

export const ACCESS_LOG_DEVICES = ['desktop', 'mobile', 'tablet', 'bot'] as const;
export type AccessLogDevice = (typeof ACCESS_LOG_DEVICES)[number];

export const DATA_SCOPES = ['all', 'member', 'own'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MENU_TYPES = ['catalog', 'menu', 'button', 'embedded', 'link'] as const;
export type MenuType = (typeof MENU_TYPES)[number];

export const LOGIN_LOG_TYPES = ['login', 'logout', 'refresh_fail'] as const;
export type LoginLogType = (typeof LOGIN_LOG_TYPES)[number];

export const AUTH_PROVIDERS = ['local', 'ldap', 'sso'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const USER_STATUS_DISABLED = 0;
export const USER_STATUS_ENABLED = 1;
export const USER_STATUSES = [USER_STATUS_DISABLED, USER_STATUS_ENABLED] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const BUILT_IN_ROLE_CODES = [
  'super_admin',
  'admin',
  'publisher',
  'viewer',
] as const;
export type BuiltInRoleCode = (typeof BUILT_IN_ROLE_CODES)[number];

/** check-code 接口 `reason` 取值（后端接口设计 §4.2） */
export const CODE_CHECK_REASONS = [
  'CODE_FORMAT_INVALID',
  'CODE_RESERVED',
  'CODE_TAKEN',
] as const;
export type CodeCheckReason = (typeof CODE_CHECK_REASONS)[number];

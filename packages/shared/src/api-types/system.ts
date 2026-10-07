import type { PermissionCode } from '../constants/permissions';
import type {
  DataScope,
  LoginLogType,
  MenuType,
  UserStatus,
} from '../enums';
import type { PageQuery } from './common';

/** 角色引用（用户列表里嵌的简版） */
export interface RoleRef {
  code: string;
  id: string;
  name: string;
}

/** GET /api/system/users 行（§7.1） */
export interface UserListItem {
  avatar: null | string;
  /** 内置账号：受 C-2 保护，不能删除或禁用最后一个 super_admin */
  builtIn: boolean;
  createdAt: string;
  email: null | string;
  id: string;
  lastLoginAt: null | string;
  lastLoginIp: null | string;
  phone: null | string;
  realName: string;
  roles: RoleRef[];
  status: UserStatus;
  username: string;
}

export interface UserDetail extends UserListItem {
  /** 该用户全部角色里最宽的数据范围（C-6） */
  dataScope: DataScope;
  remark: null | string;
}

export interface UserListQuery extends PageQuery {
  keyword?: string;
  roleId?: string;
  status?: UserStatus;
}

/** POST /api/system/users；密码由服务端随机生成并只在响应里返回一次 */
export interface CreateUserParams {
  email?: string;
  phone?: string;
  realName: string;
  remark?: string;
  roleIds: string[];
  username: string;
}

export interface CreateUserResult extends UserListItem {
  initialPassword: string;
}

/** PUT /api/system/users/{id}：username 不可改 */
export interface UpdateUserParams {
  email?: string;
  phone?: string;
  realName: string;
  remark?: string;
  status: UserStatus;
}

/** PUT /api/system/users/{id}/password 返回 newPassword 一次，且 token_version+1 */
export interface ResetUserPasswordResult {
  newPassword: string;
}

/** PUT /api/system/users/{id}/roles：覆盖式，约束 C-4 生效 */
export interface AssignUserRolesParams {
  roleIds: string[];
}

/** GET /api/system/roles：角色数量少，不分页（§7.2） */
export interface RoleListItem {
  builtIn: boolean;
  code: string;
  dataScope: DataScope;
  id: string;
  name: string;
  remark: null | string;
  sort: number;
  status: UserStatus;
  userCount: number;
}

export interface RoleDetail extends RoleListItem {
  menuIds: string[];
  permissionCodes: PermissionCode[];
}

export interface CreateRoleParams {
  code: string;
  dataScope: DataScope;
  name: string;
  remark?: string;
  sort?: number;
}

/** PUT /api/system/roles/{id}：内置角色的 code 不可改（C-1） */
export interface UpdateRoleParams {
  dataScope: DataScope;
  name: string;
  remark?: string;
  sort?: number;
  status?: UserStatus;
}

/** PUT /api/system/roles/{id}/permissions：覆盖式，会使该角色下用户的权限码缓存失效 */
export interface AssignRolePermissionsParams {
  menuIds: string[];
  permissionCodes: PermissionCode[];
}

/** GET /api/system/permissions：按 module 分组的权限码字典（§7.4），只读 */
export interface PermissionDictItem {
  code: PermissionCode;
  module: string;
  name: string;
  sort: number;
}

export interface PermissionDictGroup {
  module: string;
  permissions: PermissionDictItem[];
}

/** GET /api/system/menus：树形态，含 button 节点（§7.3） */
export interface MenuTreeNode {
  affixTab: boolean;
  authCode: null | string;
  /** 逗号分隔角色，下发前端时转成数组 */
  authority: null | string;
  badge: null | string;
  badgeType: null | string;
  children: MenuTreeNode[];
  component: null | string;
  hideInMenu: boolean;
  icon: null | string;
  id: string;
  iframeSrc: null | string;
  ignoreAccess: boolean;
  keepAlive: boolean;
  linkUrl: null | string;
  menuVisibleWithForbidden: boolean;
  name: string;
  openInNewWindow: boolean;
  path: null | string;
  pid: null | string;
  sort: number;
  status: UserStatus;
  title: string;
  type: MenuType;
}

/** POST/PUT /api/system/menus */
export interface MenuFormParams {
  affixTab?: boolean;
  authCode?: string;
  authority?: string;
  badge?: string;
  badgeType?: string;
  component?: string;
  hideInMenu?: boolean;
  icon?: string;
  iframeSrc?: string;
  ignoreAccess?: boolean;
  keepAlive?: boolean;
  linkUrl?: string;
  menuVisibleWithForbidden?: boolean;
  name: string;
  openInNewWindow?: boolean;
  path?: string;
  pid?: string;
  sort?: number;
  status?: UserStatus;
  title: string;
  type: MenuType;
}

export interface LoginLogItem {
  createdAt: string;
  failReason: null | string;
  id: string;
  ip: null | string;
  loginType: LoginLogType;
  success: boolean;
  userAgent: null | string;
  userId: null | string;
  username: string;
}

export interface LoginLogQuery extends PageQuery {
  endTime?: string;
  startTime?: string;
  success?: boolean;
  username?: string;
}

export interface OperLogItem {
  action: string;
  createdAt: string;
  /** 变更差异，服务端已按脱敏规则处理（不含密码/令牌） */
  detail: null | Record<string, unknown>;
  durationMs: null | number;
  errorMessage: null | string;
  id: string;
  ip: null | string;
  method: null | string;
  module: string;
  path: null | string;
  resourceId: null | string;
  resourceName: null | string;
  resourceType: null | string;
  success: boolean;
  userId: null | string;
  username: null | string;
}

export interface OperLogQuery extends PageQuery {
  action?: string;
  endTime?: string;
  resourceId?: string;
  resourceType?: string;
  startTime?: string;
  username?: string;
}

/** GET /api/health（§9.4，无鉴权） */
export interface HealthResult {
  status: 'ok';
  version: string;
}

/** GET /api/health/detail，需 system:log:list */
export interface HealthDetailResult extends HealthResult {
  database: 'down' | 'up';
  diskFreeBytes: number;
  queueDepth: number;
}

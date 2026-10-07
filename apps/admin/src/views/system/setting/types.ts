import type { MenuTreeNode, RoleListItem, UserListItem } from '@protohub/shared';

/** 一次性密码弹窗的入参（创建用户 initialPassword / 重置密码 newPassword） */
export interface OneTimePasswordPayload {
  kind: 'created' | 'reset';
  password: string;
  username: string;
}

/** 分配角色弹窗的入参 */
export interface AssignRolesPayload {
  roleIds: string[];
  user: UserListItem;
}

/** 角色管理：右侧配置面板的入参（null 表示新建态） */
export interface RoleSelection {
  role: null | RoleListItem;
}

/** 菜单抽屉的入参：id 为空表示新建 */
export interface MenuFormPayload {
  id?: string;
  /** 从行操作"新增子项"进入时预置的父级 */
  pid?: null | string;
  presetType?: MenuTreeNode['type'];
  /** 当前菜单树：抽屉内"上级菜单"下拉的数据源 */
  tree?: MenuTreeNode[];
}

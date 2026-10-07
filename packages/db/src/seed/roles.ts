/**
 * 内置角色与"角色 → 权限码"派生（权限模型设计 §4/§6、数据库设计 §6.2）。
 *
 * 权限码永远不在此文件硬编码：所有集合都是对 @protohub/shared `PERMISSIONS`
 * 的谓词过滤（文档 §4 用"除 xx 外全部 / 按动作分类"描述各角色，谓词就是该描述的直译）。
 * 这样新增权限码时只需改 shared，seed 自动生效——但也意味着新码会按动作
 * 自动落入 publisher/viewer，上线前要对 §4 清单做一次人工核对（M1-T16 一致性脚本负责兜底比对）。
 */
import { PERMISSIONS, PERMISSION_CODES, type PermissionCode } from '@protohub/shared';

export interface BuiltInRoleDef {
  /** sys_role.code，与 shared BUILT_IN_ROLE_CODES 一致 */
  code: 'super_admin' | 'admin' | 'publisher' | 'viewer';
  name: string;
  /** 数据范围：权限模型 §6.1；super_admin/admin=all，publisher/viewer=member */
  dataScope: 'all' | 'member' | 'own';
  sort: number;
  remark: string;
}

export const BUILT_IN_ROLES: readonly BuiltInRoleDef[] = [
  {
    code: 'super_admin',
    name: '超级管理员',
    dataScope: 'all',
    sort: 1,
    remark: '拥有全部权限，不可删除',
  },
  {
    code: 'admin',
    name: '平台管理员',
    dataScope: 'all',
    sort: 2,
    remark: '除菜单管理与角色授权外的全部权限',
  },
  {
    code: 'publisher',
    name: '发布者',
    dataScope: 'member',
    sort: 3,
    remark: '可发布/回滚自己参与的项目',
  },
  {
    code: 'viewer',
    name: '只读访客',
    dataScope: 'member',
    sort: 4,
    remark: '只读项目信息与访问记录',
  },
] as const;

/** `{域}:{资源}:{操作}` 的最后一段（权限模型 §3 命名规范）。 */
function actionOf(code: PermissionCode): string {
  return code.split(':')[2] as string;
}

/**
 * publisher 危险动作黑名单（权限模型 §4 注："publisher 不包含任何 delete"，
 * 且 §4 清单不含 export/download——那两个都是 P1 的读侧导出/下载）。
 */
const PUBLISHER_EXCLUDED_ACTIONS = new Set(['delete', 'archive', 'export', 'download']);
const VIEWER_ALLOWED_ACTIONS = new Set(['view', 'list', 'read']);

/** 按权限模型 §4 的"权限范围"列，从 PERMISSIONS 派生某角色的权限码集合。 */
export function permissionCodesFor(role: BuiltInRoleDef['code']): PermissionCode[] {
  switch (role) {
    case 'super_admin': {
      return [...PERMISSION_CODES];
    }
    case 'admin': {
      // §4：除 system:menu:* 与 system:role:assignperm 外的全部（同数据库设计 §6.2 SQL）
      return PERMISSIONS.filter(
        (p) => !p.code.startsWith('system:menu:') && p.code !== 'system:role:assignperm',
      ).map((p) => p.code);
    }
    case 'publisher': {
      // §4：dashboard/proto 两域（即"参与项目"的日常操作），排除删除/归档/导出/下载
      return PERMISSIONS.filter(
        (p) =>
          (p.module === 'dashboard' || p.module === 'proto') &&
          !PUBLISHER_EXCLUDED_ACTIONS.has(actionOf(p.code)),
      ).map((p) => p.code);
    }
    case 'viewer': {
      // §4：纯只读——view/list/read 三个动作，且不含任何 system 码
      return PERMISSIONS.filter(
        (p) =>
          (p.module === 'dashboard' || p.module === 'proto') &&
          VIEWER_ALLOWED_ACTIONS.has(actionOf(p.code)),
      ).map((p) => p.code);
    }
    default: {
      throw new Error(`未知内置角色: ${role satisfies never}`);
    }
  }
}

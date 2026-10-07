import type { PermissionDictGroup } from '@protohub/shared';

import { isPermissionCode } from '@protohub/shared';

import type { CheckableTreeNode } from './menu-tree';

/**
 * 权限码字典（GET /system/permissions，按 module 分组）→ antd Tree 勾选树。
 * 分组节点 key 带 `group:` 前缀，保存时用 isPermissionCode 过滤掉，
 * 保证提交的永远是真实权限码（与 shared 常量对齐，不信任字典数据）。
 */
export function permissionGroupsToTree(
  groups: readonly PermissionDictGroup[],
  resolveModuleTitle?: (module: string) => string,
): CheckableTreeNode[] {
  return groups.map((group) => ({
    children: group.permissions.map((permission) => ({
      key: permission.code,
      title: `${permission.name}（${permission.code}）`,
    })),
    key: `group:${group.module}`,
    title: resolveModuleTitle ? resolveModuleTitle(group.module) : group.module,
  }));
}

/** Tree 勾选结果（含 group: 前缀的父节点 key）→ 纯权限码数组 */
export function extractPermissionCodes(
  checkedKeys: readonly (number | string)[],
): string[] {
  return checkedKeys
    .map((key) => String(key))
    .filter((key) => isPermissionCode(key));
}

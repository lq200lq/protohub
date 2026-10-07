import type { PermissionCode } from '@protohub/shared';

import type { RouteRecordStringComponent } from '@vben/types';

/**
 * 二级子菜单节点名 → 进入所需权限码（前端设计 §3.8）。
 *
 * 页面可见性不挂 `sys_menu.auth_code`（权限模型 §3.7：auth_code 只挂 button），
 * 与原设置页 Tab 的过滤同源同语义：无权限的子菜单直接从菜单树与路由注册里剪掉，
 * 侧栏不出现、直达 URL 落 404，而不是置灰。
 */
export const MENU_ACCESS_CODES: Partial<Record<string, PermissionCode>> = {
  SystemSettingLog: 'system:log:list',
  SystemSettingMenu: 'system:menu:list',
  SystemSettingRole: 'system:role:list',
  SystemSettingUser: 'system:user:list',
};

/**
 * 按权限码集合剪枝整棵菜单树（单测覆盖）。
 * 父节点不因子项被剪光而删除——系统设置恒有无需权限码的「账号安全」子项。
 */
export function filterMenusByAccess(
  menus: readonly RouteRecordStringComponent[],
  codes: readonly string[],
): RouteRecordStringComponent[] {
  const result: RouteRecordStringComponent[] = [];
  for (const menu of menus) {
    const name = typeof menu.name === 'string' ? menu.name : undefined;
    const required = name ? MENU_ACCESS_CODES[name] : undefined;
    if (required && !codes.includes(required)) continue;
    if (menu.children && menu.children.length > 0) {
      result.push({
        ...menu,
        children: filterMenusByAccess(menu.children, codes),
      });
    } else {
      result.push(menu);
    }
  }
  return result;
}

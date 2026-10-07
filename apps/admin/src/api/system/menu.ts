import type { MenuFormParams, MenuTreeNode } from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/system/menus（§7.3.1）：树形态、含 button 节点、不分页 */
export function getMenuTreeApi() {
  return requestClient.get<MenuTreeNode[]>('/system/menus');
}

/** POST /api/system/menus（§7.3.2） */
export function createMenuApi(data: MenuFormParams) {
  return requestClient.post<MenuTreeNode>('/system/menus', data);
}

/** PUT /api/system/menus/{id}（§7.3.3） */
export function updateMenuApi(id: string, data: MenuFormParams) {
  return requestClient.put<void>(`/system/menus/${id}`, data);
}

/** DELETE /api/system/menus/{id}（§7.3.4）：有子节点时后端 400 MENU_HAS_CHILDREN */
export function deleteMenuApi(id: string) {
  return requestClient.delete<void>(`/system/menus/${id}`);
}

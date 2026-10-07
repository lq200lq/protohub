import type {
  AssignRolePermissionsParams,
  CreateRoleParams,
  PermissionDictGroup,
  RoleDetail,
  RoleListItem,
  UpdateRoleParams,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/system/roles（§7.2.1）：全量列表，不分页 */
export function getSystemRolesApi() {
  return requestClient.get<RoleListItem[]>('/system/roles');
}

/** GET /api/system/roles/{id}（§7.2.2）：含 permissionCodes 与 menuIds */
export function getSystemRoleDetailApi(id: string) {
  return requestClient.get<RoleDetail>(`/system/roles/${id}`);
}

/** POST /api/system/roles（§7.2.3） */
export function createSystemRoleApi(data: CreateRoleParams) {
  return requestClient.post<RoleListItem>('/system/roles', data);
}

/** PUT /api/system/roles/{id}（§7.2.4）：内置角色的 code 不可改（C-1） */
export function updateSystemRoleApi(id: string, data: UpdateRoleParams) {
  return requestClient.put<void>(`/system/roles/${id}`, data);
}

/** DELETE /api/system/roles/{id}（§7.2.5）：内置角色不可删；有用户绑定 400 ROLE_IN_USE */
export function deleteSystemRoleApi(id: string) {
  return requestClient.delete<void>(`/system/roles/${id}`);
}

/** PUT /api/system/roles/{id}/permissions（§7.2.6）：覆盖式，保存后即时生效 */
export function assignRolePermissionsApi(
  id: string,
  data: AssignRolePermissionsParams,
) {
  return requestClient.put<void>(`/system/roles/${id}/permissions`, data);
}

/** GET /api/system/permissions（§7.4）：按 module 分组的权限码字典，只读 */
export function getPermissionDictApi() {
  return requestClient.get<PermissionDictGroup[]>('/system/permissions');
}

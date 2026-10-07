import type {
  AssignUserRolesParams,
  CreateUserParams,
  CreateUserResult,
  PageResult,
  ResetUserPasswordResult,
  UpdateUserParams,
  UserDetail,
  UserListItem,
  UserListQuery,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/system/users（后端接口设计 §7.1.1） */
export function getSystemUsersApi(params: UserListQuery) {
  return requestClient.get<PageResult<UserListItem>>('/system/users', {
    params,
  });
}

/** GET /api/system/users/{id}（§7.1.3），详情含角色与数据范围 */
export function getSystemUserDetailApi(id: string) {
  return requestClient.get<UserDetail>(`/system/users/${id}`);
}

/** POST /api/system/users（§7.1.2）：密码由服务端随机生成，只在响应里返回一次 */
export function createSystemUserApi(data: CreateUserParams) {
  return requestClient.post<CreateUserResult>('/system/users', data);
}

/** PUT /api/system/users/{id}（§7.1.4）：username 不可改 */
export function updateSystemUserApi(id: string, data: UpdateUserParams) {
  return requestClient.put<void>(`/system/users/${id}`, data);
}

/** DELETE /api/system/users/{id}（§7.1.5）：软删除，约束 C-2/C-3 由后端强制 */
export function deleteSystemUserApi(id: string) {
  return requestClient.delete<void>(`/system/users/${id}`);
}

/** PUT /api/system/users/{id}/password（§7.1.6）：重置为随机密码并返回一次 */
export function resetSystemUserPasswordApi(id: string) {
  return requestClient.put<ResetUserPasswordResult>(
    `/system/users/${id}/password`,
  );
}

/** PUT /api/system/users/{id}/roles（§7.1.7）：覆盖式，约束 C-4 由后端强制 */
export function assignSystemUserRolesApi(
  id: string,
  data: AssignUserRolesParams,
) {
  return requestClient.put<void>(`/system/users/${id}/roles`, data);
}

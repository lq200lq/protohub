import type {
  ChangePasswordParams,
  UpdateProfileParams,
  UserDetail,
  UserInfo,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/**
 * 获取用户信息（§2.5）：含 vben 必需字段 + dataScope / forcePasswordChange
 */
export async function getUserInfoApi() {
  return requestClient.get<UserInfo>('/user/info');
}

/** 本人资料详情（§2.7 读侧）：比 /user/info 多 lastLoginAt/lastLoginIp 与 dataScope */
export async function getProfileApi() {
  return requestClient.get<UserDetail>('/user/profile');
}

/** 修改本人资料（§2.7），仅 realName/email/phone/avatar 可改；响应为最新的 UserDetail */
export async function updateProfileApi(data: UpdateProfileParams) {
  return requestClient.put<UserDetail>('/user/profile', data);
}

/**
 * 修改本人密码（§2.8）：成功后 token_version+1、服务端清 Cookie，
 * 前端必须引导重新登录
 */
export async function changePasswordApi(data: ChangePasswordParams) {
  return requestClient.put<void>('/user/password', data);
}

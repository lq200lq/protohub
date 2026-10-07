import type { AuthCodes, LoginParams, LoginResult } from '@protohub/shared';

import { baseRequestClient, requestClient } from '#/api/request';

/**
 * baseRequestClient 不挂默认响应拦截器（responseReturn:'raw'），
 * 因此拿到的是 axios 响应对象，resp.data 即裸字符串响应体（后端接口设计 §2.2）。
 */
interface RawTextResponse {
  data: string;
  status: number;
}

/**
 * 登录（§2.1）：data.accessToken 为字符串；refreshToken 走 HttpOnly Cookie 下发
 */
export async function loginApi(data: LoginParams) {
  return requestClient.post<LoginResult>('/auth/login', data);
}

/**
 * 刷新 accessToken（§2.2）：成功时响应体是【裸字符串】，不是 {code,data} 包装。
 * 写错会表现为 Bearer [object Object]（迭代实施计划 §8 F-1）
 */
export async function refreshTokenApi() {
  return baseRequestClient.post<RawTextResponse>('/auth/refresh', null, {
    withCredentials: true,
  });
}

/**
 * 退出登录（§2.3）：服务端清 proto_refresh / proto_sess
 */
export async function logoutApi() {
  return baseRequestClient.post('/auth/logout', null, {
    withCredentials: true,
  });
}

/**
 * 当前用户全部权限码（§2.4）：super_admin 返回全集而不是空数组
 */
export async function getAccessCodesApi() {
  return requestClient.get<AuthCodes>('/auth/codes');
}

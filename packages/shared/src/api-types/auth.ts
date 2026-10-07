import type { PermissionCode } from '../constants/permissions';

/** POST /api/auth/login 请求体 */
export interface LoginParams {
  password: string;
  username: string;
}

/** POST /api/auth/login 返回；accessToken 字段名是 vben 写死的取值路径（§2.1，同时下发两个 Cookie） */
export interface LoginResult {
  accessToken: string;
  avatar: null | string;
  homePath: string;
  realName: string;
  roles: string[];
  userId: string;
  username: string;
}

/**
 * POST /api/auth/refresh 成功时响应体是裸字符串（text/plain），不是 ApiEnvelope。
 * 见 §2.2：vben 用 responseReturn:'raw' 的客户端直接把 resp.data 当 token 用。
 */
export type RefreshedAccessToken = string;

/** GET /api/auth/codes —— super_admin 返回全集而不是空数组 */
export type AuthCodes = PermissionCode[];

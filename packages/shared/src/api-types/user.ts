import type { DataScope } from '../enums';

/** GET /api/user/info 返回；userId/username/realName/avatar/roles/homePath 是 vben 必需字段（§2.5） */
export interface UserInfo {
  avatar: null | string;
  dataScope: DataScope;
  desc: null | string;
  email: null | string;
  forcePasswordChange: boolean;
  homePath: string;
  phone: null | string;
  realName: string;
  roles: string[];
  userId: string;
  username: string;
}

/** PUT /api/user/profile：仅这四个字段可改 */
export interface UpdateProfileParams {
  avatar?: string;
  email?: string;
  phone?: string;
  realName: string;
}

/** PUT /api/user/password；新密码强度校验见 §2.8，成功后其它设备会话失效 */
export interface ChangePasswordParams {
  newPassword: string;
  oldPassword: string;
}

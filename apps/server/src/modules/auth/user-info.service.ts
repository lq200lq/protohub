import { Injectable } from '@nestjs/common';
import type { UserInfo } from '@protohub/shared';

import type { AuthUser } from '../../common/permission/auth-user';
import { HOME_PATH } from './auth.constants';

/**
 * `GET /api/user/info`（后端接口设计 §2.5）。
 *
 * 直接用 Guard 放进 `request.user` 的那份：Guard 本来就要为 `token_version`/`status`
 * 查一次**不缓存**的库（权限模型设计 §8.2），再查一遍纯属浪费。
 */
@Injectable()
export class UserInfoService {
  infoOf(user: AuthUser): UserInfo {
    return {
      avatar: user.avatar,
      dataScope: user.dataScope,
      desc: user.primaryRoleName,
      email: user.email,
      forcePasswordChange: user.forcePasswordChange,
      homePath: HOME_PATH,
      phone: user.phone,
      realName: user.realName,
      roles: [...user.roles],
      userId: user.userId,
      username: user.username,
    };
  }
}

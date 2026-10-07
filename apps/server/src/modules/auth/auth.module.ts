import { Module } from '@nestjs/common';

import { PermissionModule } from '../../common/permission/permission.module';
import { AuthController } from './auth.controller';
import { AuthSessionService } from './auth-session.service';
import { AuthService } from './auth.service';
import { LoginLogService } from './login-log.service';
import { LoginLockService } from './login-lock.service';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import { UserInfoController } from './user-info.controller';
import { UserInfoService } from './user-info.service';

/**
 * 认证与"当前用户"三件套（M1-T5/T6/T8）。
 *
 * 登录态本身（Guard、权限码缓存、Cookie/会话签发）在 `common/permission`，
 * 这里只放对外接口与登录流程策略（失败锁定、审计、令牌轮转）。
 */
@Module({
  imports: [PermissionModule],
  controllers: [AuthController, UserInfoController, MenuController],
  providers: [
    AuthService,
    AuthSessionService,
    LoginLockService,
    LoginLogService,
    UserInfoService,
    MenuService,
  ],
  exports: [AuthService, AuthSessionService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccountService } from './account.service';
import { AuthGuard } from './auth.guard';
import { CookieService } from './cookie.service';
import { JwtTokenService } from './jwt-token.service';
import {
  PERMISSION_CACHE_INVALIDATOR,
  createPermissionCacheInvalidator,
} from './permission-cache-invalidator';
import { PermissionCodeService } from './permission-code.service';
import { SessionService } from './session.service';

/**
 * 鉴权底座。
 *
 * 被 `AuthModule` / `PermissionCacheModule` 等 import（Nest 里同一模块多处 import 只有一个实例），
 * 所以 `PermissionCodeService` 内部那份 30 秒缓存是**全局唯一**的：
 * 读方（Guard）与写方（system 的失效调用）必须命中同一个实例，"改权限即时生效"才成立。
 * 全局守卫在这里注册，`app.module.ts` 只需 import 本模块。
 */
@Module({
  providers: [
    JwtTokenService,
    AccountService,
    PermissionCodeService,
    {
      provide: PERMISSION_CACHE_INVALIDATOR,
      useFactory: createPermissionCacheInvalidator,
      inject: [PermissionCodeService],
    },
    CookieService,
    SessionService,
    AuthGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [
    AccountService,
    CookieService,
    JwtTokenService,
    PermissionCodeService,
    PERMISSION_CACHE_INVALIDATOR,
    SessionService,
  ],
})
export class PermissionModule {}

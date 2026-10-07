import { Module } from '@nestjs/common';

import { PermissionModule } from '../../common/permission/permission.module';
import { ProjectModule } from '../project/project.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { AccessLogModule } from '../accesslog/accesslog.module';
import { AccessController } from './access.controller';
import { AccessRepo } from './access.repo';
import { AccessService } from './access.service';
import { PrototypeStaticRoute } from './prototype-static.route';
import { PrototypeStaticService } from './prototype-static.service';
import { UnlockRateLimiter } from './unlock-rate-limiter.service';
import { UnlockService } from './unlock.service';
import { UnlockTokenService } from './unlock-token.service';

/**
 * 平台设计方案 §7.1：访问决策（供 nginx auth_request）与密码档解锁（M4）。
 *
 * 引 `ProjectModule` 与原型模块同一条理由：成员档的可见性判定只有一份实现
 * （`ProjectRepo.findInScope` + `projectScopeWhere`，权限模型 §6.2），这里不能再拼一遍。
 * 引 `PermissionModule` 是为了 `SessionService`/`AccountService`——`proto_sess` 的验签与
 * `token_version` 比对在 M1 就做好了（机制 §5.4 的 Cookie 正是那次落地的），M4 只消费。
 *
 * 对外只导出 `AccessService` 与 `UnlockTokenService`：取行与判定顺序是实现细节，
 * 直出中间件与 `/api/access/check` 两个入口都只走 `decide()`，这样"本地与生产同一口径"（D-05）
 * 在结构上就成立。控制器随 M4-T3/T6 接进来；M4-T4/T5 的 Node 直出（`PrototypeStaticService`
 * + `PrototypeStaticRoute`）也放在这里，因为它与 `/api/access/check` 是同一个判定的两个入口，
 * 分成两个模块只会让"改了这边忘了那边"成为可能。
 */
@Module({
  imports: [SystemDataModule, PermissionModule, ProjectModule, AccessLogModule],
  controllers: [AccessController],
  providers: [
    AccessRepo,
    AccessService,
    PrototypeStaticRoute,
    PrototypeStaticService,
    UnlockRateLimiter,
    UnlockService,
    UnlockTokenService,
  ],
  exports: [AccessService, UnlockTokenService],
})
export class AccessModule {}

import { Module } from '@nestjs/common';

import { SystemDataModule } from '../persistence/system-data.module';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { SystemAuditModule } from '../audit/audit.module';
import { UserController } from './user.controller';
import { UserProfileController } from './user-profile.controller';
import { UserService } from './user.service';

/** 平台设计方案 §7.1 / 后端接口设计 §7.1：用户 CRUD、重置密码、启停、角色分配 + §2.7/§2.8 个人中心。 */
@Module({
  imports: [SystemDataModule, PermissionCacheModule, SystemAuditModule],
  controllers: [UserController, UserProfileController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}

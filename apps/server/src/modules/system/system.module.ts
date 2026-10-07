import { Module } from '@nestjs/common';

import { LogModule } from './log/log.module';
import { MenuModule } from './menu/menu.module';
import { PermissionModule } from './permission/permission.module';
import { RoleModule } from './role/role.module';
import { UserModule } from './user/user.module';

/**
 * 平台设计方案 §7.1 的 system 模块：user / role / permission / menu / log 五个子模块，
 * 目录层级与文档一致，后续阶段只往子目录里加 controller/service。
 */
@Module({
  imports: [UserModule, RoleModule, PermissionModule, MenuModule, LogModule],
})
export class SystemModule {}

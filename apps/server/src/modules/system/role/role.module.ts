import { Module } from '@nestjs/common';

import { SystemDataModule } from '../persistence/system-data.module';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { SystemAuditModule } from '../audit/audit.module';
import { RoleController } from './role.controller';
import { RoleService } from './role.service';

/** 平台设计方案 §7.1 / 后端接口设计 §7.2：角色 CRUD、权限码与菜单分配、数据范围（M1-T12 后端侧）。 */
@Module({
  imports: [SystemDataModule, PermissionCacheModule, SystemAuditModule],
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService],
})
export class RoleModule {}

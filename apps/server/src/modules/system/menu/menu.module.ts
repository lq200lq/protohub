import { Module } from '@nestjs/common';

import { SystemDataModule } from '../persistence/system-data.module';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { SystemAuditModule } from '../audit/audit.module';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';

/** 平台设计方案 §7.1 / 后端接口设计 §7.3：菜单树 CRUD 与启停（M1-T13 后端侧）。 */
@Module({
  imports: [SystemDataModule, PermissionCacheModule, SystemAuditModule],
  controllers: [MenuController],
  providers: [MenuService],
  exports: [MenuService],
})
export class MenuModule {}

import { Module } from '@nestjs/common';

import { PermissionController } from './permission.controller';
import { PermissionDictService } from './permission-dict.service';

/** 平台设计方案 §7.1 / 后端接口设计 §7.4：权限码字典只读接口（数据源是代码常量，无 DB 依赖）。 */
@Module({
  controllers: [PermissionController],
  providers: [PermissionDictService],
  exports: [PermissionDictService],
})
export class PermissionModule {}

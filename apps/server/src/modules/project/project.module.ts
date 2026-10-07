import { Module } from '@nestjs/common';

import { SystemAuditModule } from '../system/audit/audit.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { ProjectController } from './project.controller';
import { ProjectRepo } from './project.repo';
import { ProjectService } from './project.service';

/**
 * 平台设计方案 §7.1：项目 CRUD、编码生成校验、成员、归档（M2-T1/T2）。
 *
 * `ProjectRepo` 对外导出：原型的可见性一律通过父项目判定（权限模型设计 §6.2），
 * PrototypeModule 复用同一个 repo，而不是再写一遍范围过滤。
 */
@Module({
  imports: [SystemDataModule, SystemAuditModule],
  controllers: [ProjectController],
  providers: [ProjectService, ProjectRepo],
  exports: [ProjectRepo],
})
export class ProjectModule {}

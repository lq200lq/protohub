import { Module } from '@nestjs/common';

import { ProjectModule } from '../project/project.module';
import { SystemAuditModule } from '../system/audit/audit.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { PrototypeController } from './prototype.controller';
import { PrototypeRepo } from './prototype.repo';
import { PrototypeService } from './prototype.service';

/**
 * 平台设计方案 §7.1：原型 CRUD、编码、访问策略、状态流转。
 *
 * 引 `ProjectModule` 而不是自己再写一份范围判定（权限模型 §6.2）：原型的可见性一律通过父项目判定，
 * `ProjectRepo` 是那条判定的唯一实现，M3 的发布链路同样要复用它。
 *
 * `PrototypeRepo` 对外导出，理由与 `ProjectModule` 导出 `ProjectRepo` 同一条：
 * 受理发布（机制 §3.0）要在同一个事务里插原型行、并复用"项目内活跃编码"的取法，
 * 再来一份实现就会和列表/详情的口径漂移。
 *
 * `PrototypeService` 也导出：§5.5 回滚的响应体是"更新后的原型详情"，而详情的字段口径
 * （访问地址、当前版本摘要、成员）只有这一处实现；回滚再拼一份 `buildDetail` 就是第二条真相。
 */
@Module({
  imports: [SystemDataModule, SystemAuditModule, ProjectModule],
  controllers: [PrototypeController],
  providers: [PrototypeService, PrototypeRepo],
  exports: [PrototypeRepo, PrototypeService],
})
export class PrototypeModule {}

import { Module } from '@nestjs/common';

import { PermissionModule } from '../../common/permission/permission.module';
import { ProjectModule } from '../project/project.module';
import { PrototypeModule } from '../prototype/prototype.module';
import { SystemAuditModule } from '../system/audit/audit.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { ReleaseCommitter } from './pipeline/commit';
import { ReleaseController } from './release.controller';
import { ReleaseRepo } from './release.repo';
import { ReleaseService } from './release.service';
import { UploadTaskController } from './task/task.controller';
import { UploadTaskService } from './task/task.service';
import { VersionController } from './version/version.controller';
import { VersionRepo } from './version/version.repo';
import { VersionService } from './version/version.service';
import { UploadTaskRepo } from './worker/upload-task.repo';
import { UploadWorkerService } from './worker/upload-worker.service';

/**
 * 平台设计方案 §7.1：发布流水线、版本、回滚、GC。
 *
 * 依赖全部走既有 repo，不重复实现判定：
 * - `ProjectModule` / `PrototypeModule` 导出各自的 repo —— 数据范围（权限模型 §6.2）与编码占用预查
 *   只有那一处实现，受理若另写一份过滤就会出现"列表看得见、发布报没权限"（§3.7）。
 * - `PermissionModule` 提供 `PermissionCodeService` —— §5.1 的 AND 权限要按用户实际持有的码判定。
 * - `StorageModule` 与 `SystemDataModule` 是 `@Global`，这里只显式 import 后者以保持与其他模块一致的读法。
 *
 * `UploadWorkerService` 也在本模块注册：它监听 `onApplicationBootstrap` 起轮询，所以必须是个
 * provider 而不是在 `main.ts` 里手工 new——否则换实现、注入依赖都得绕过容器。
 *
 * 读侧（§5.3 任务状态、§5.4–§5.8 版本与时间线）与写侧同属一个模块但各管一类行：
 * `worker/` 读任务行、`version/` 读版本与版本事件行、`pipeline/` 只负责写。
 * 分开的理由是 §3.3 那条"队列与版本写入互不插队"——读的一侧交叉了，将来加 GC（M5-T6）时就分不清
 * 谁有权把一条版本置成 `deleted`。
 *
 * `VersionRepo` 对外导出，只为工作台 §3.1：那张卡的"本周发布次数"和"最近动态"要的是版本行的计数
 * 与版本事件的取列，与 §5.4/§5.8 必须是同一条尺子（再写一份 select 就会出现卡片与时间线对不上）。
 */
@Module({
  imports: [
    SystemDataModule,
    SystemAuditModule,
    PermissionModule,
    ProjectModule,
    PrototypeModule,
  ],
  controllers: [ReleaseController, UploadTaskController, VersionController],
  providers: [
    ReleaseService,
    ReleaseRepo,
    ReleaseCommitter,
    UploadTaskRepo,
    UploadTaskService,
    UploadWorkerService,
    VersionRepo,
    VersionService,
  ],
  exports: [VersionRepo],
})
export class ReleaseModule {}

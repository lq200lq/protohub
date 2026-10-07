import { Module } from '@nestjs/common';

import { PermissionModule } from '../../common/permission/permission.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { AccessLogBufferService } from './access-log.buffer.service';
import { AccessLogQueryController } from './access-log.query.controller';
import { AccessLogQueryRepo } from './access-log.query.repo';
import { AccessLogQueryService } from './access-log.query.service';
import { AccessLogRecorderService } from './access-log.recorder.service';
import { AccessLogRepo } from './access-log.repo';

/**
 * 平台设计方案 §7.1：访问记录写入（异步批量，M4-T9）与查询聚合（M4-T10）。
 *
 * 写入侧对外只暴露 `AccessLogRecorderService`：缓冲、批次、列宽裁剪、UA 解析都是实现细节，
 * 三个入口（`/api/access/check`、`/api/access/gate`、Node 直出路由）只需要"把这次判定交过来"。
 * 反过来它们也不该各写一遍口径——那份判断在 `record-policy.ts`，三处共用（机制 §6）。
 *
 * `PermissionModule` 只给读侧：`maskIp` 要看这个调用者有没有 `system:log:list`，
 * 而 `AuthUser` 上不带权限码表（机制 §6.1 的 IP 打码是给"项目成员看自己原型"用的，
 * 不能靠前端传标志）。写侧三个入口都不需要它。
 *
 * 读侧对外导出 `AccessLogQueryService`：工作台 §3.1 的访问统计要用同一条范围解析与同一把日历日
 * 窗口尺子（不然"卡片上的近 7 天"和"点开访问记录"会对不上），而不是在 dashboard 里再写一份 SQL。
 */
@Module({
  controllers: [AccessLogQueryController],
  imports: [PermissionModule, SystemDataModule],
  providers: [
    AccessLogBufferService,
    AccessLogQueryRepo,
    AccessLogQueryService,
    AccessLogRecorderService,
    AccessLogRepo,
  ],
  exports: [AccessLogQueryService, AccessLogRecorderService],
})
export class AccessLogModule {}

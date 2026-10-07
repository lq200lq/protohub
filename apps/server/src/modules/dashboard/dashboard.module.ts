import { Module } from '@nestjs/common';

import { AccessLogModule } from '../accesslog/accesslog.module';
import { ProjectModule } from '../project/project.module';
import { PrototypeModule } from '../prototype/prototype.module';
import { ReleaseModule } from '../release/release.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * 平台设计方案 §7.1：工作台统计（M5-T1）。
 *
 * 本模块没有自己的 repo，也不该有：四个数字各自的口径已经住在归属方那一侧——
 * 项目/原型状态数在 `ProjectRepo`/`PrototypeRepo`（与列表页同一条 `listWhere`）、
 * 发布数与最近动态在 `VersionRepo`（与版本列表、时间线同一条 select）、
 * 访问统计在 `AccessLogQueryService`（与访问记录页同一条范围解析与窗口）。
 * 在这里再写一份 SQL 就是第四份真相，"工作台与列表对不上"会从那开始（§3.7）。
 */
@Module({
  imports: [AccessLogModule, ProjectModule, PrototypeModule, ReleaseModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { CommonModule } from './common/common.module';
import { PermissionModule } from './common/permission/permission.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { AccessLogModule } from './modules/accesslog/accesslog.module';
import { AccessModule } from './modules/access/access.module';
import { AuthModule } from './modules/auth/auth.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { GcModule } from './modules/gc/gc.module';
import { ProjectModule } from './modules/project/project.module';
import { PrototypeModule } from './modules/prototype/prototype.module';
import { ReleaseModule } from './modules/release/release.module';
import { StorageModule } from './modules/storage/storage.module';
import { SystemModule } from './modules/system/system.module';

/**
 * 模块清单与 平台设计方案.md §7.1 一一对应（system 的四个子模块在 SystemModule 下）。
 * M0 阶段它们只是空壳：后续阶段往里填 controller/service，不需要再动这里的接线。
 *
 * `PermissionModule` 里注册了全局 AuthGuard（M1-T7），必须在业务模块之前接上。
 */
@Module({
  imports: [
    // GC 的定时触发（机制 §4.3：每天 03:30 + 启动 5 分钟后一次）挂在 @nestjs/schedule 上
    ScheduleModule.forRoot(),
    AppConfigModule,
    CommonModule,
    PermissionModule,
    HealthModule,
    AuthModule,
    SystemModule,
    ProjectModule,
    PrototypeModule,
    ReleaseModule,
    StorageModule,
    AccessModule,
    AccessLogModule,
    DashboardModule,
    GcModule,
  ],
})
export class AppModule {}

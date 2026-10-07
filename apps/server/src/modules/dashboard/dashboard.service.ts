import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  DashboardOverview,
  RecentEventItem,
  RecentPrototypeItem,
} from '@protohub/shared';

import { accessUrlOf, prototypeAccessPath } from '../../common/access-path';
import { localTodayStart, localWeekStart } from '../../common/calendar-window';
import { andPrototypeScope, toActorScope, type ActorScope } from '../../common/data-scope';
import { AppEnvService } from '../../config/app-env.service';
import { AccessLogQueryService } from '../accesslog/access-log.query.service';
import { ProjectRepo } from '../project/project.repo';
import { PrototypeRepo, createEmptyPrototypeAggregates } from '../prototype/prototype.repo';
import { VersionRepo } from '../release/version/version.repo';
import type { Actor } from '../system/common/actor';

/**
 * 工作台概览（[后端接口设计.md](../../../../../../docs/后端接口设计.md) §3.1；迭代实施计划 M5-T1）。
 *
 * 这一层只做编排，不做第四份统计口径：
 * 1. **两个状态计数走各自 repo 的 `statusCounts`**，而那三个条件分支就是列表页 `listWhere` 用的
 *    同一条——判据"数据与项目列表能对上"因此是由构造保证的，不是靠两处手抄同样的 where；
 * 2. **访问统计走 `AccessLogQueryService`**：范围解析、日历日窗口、UV 去重都在访问记录那一侧
 *    （§6.2），工作台点开访问记录页看到的必须是同一批行；
 * 3. **`recentPrototypes` 按原型自己的 `updatedAt` 取**（不是按项目，这是 §3.1 点名的坑），
 *    访问量复用列表页那条 `aggregatesFor`。
 *
 * 六块数据并发取：任何一块都不依赖另一块的结果，串行会把首屏拖成六次往返。
 */

/** §3.1：左栏取最近更新的 5 个原型。 */
export const RECENT_PROTOTYPE_LIMIT = 5;

/** §3.1：右栏取最近 10 条版本事件。 */
export const RECENT_EVENT_LIMIT = 10;

/** 三块按原型的统计共用的可见性：原型未软删，且父项目在这个人的范围内（权限模型 §6.2）。 */
function visiblePrototypes(scope: ActorScope): Prisma.ProtoPrototypeWhereInput {
  return andPrototypeScope(scope, { deletedAt: null });
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly projects: ProjectRepo,
    private readonly prototypes: PrototypeRepo,
    private readonly versions: VersionRepo,
    private readonly accessLogs: AccessLogQueryService,
    private readonly appEnv: AppEnvService,
  ) {}

  async overview(actor: Actor): Promise<DashboardOverview> {
    const scope = toActorScope(actor);
    const [projectStats, prototypeStats, releaseStats, visitStats, recentPrototypes, recentEvents] =
      await Promise.all([
        this.projects.statusCounts(scope),
        this.prototypes.statusCounts(scope),
        this.versions.publishedCounts(visiblePrototypes(scope), {
          thisWeekStart: localWeekStart(),
          todayStart: localTodayStart(),
        }),
        this.accessLogs.dashboardVisitStats(actor),
        this.recentPrototypeItems(scope),
        this.recentEventItems(scope),
      ]);
    return {
      projectStats,
      prototypeStats,
      recentEvents,
      recentPrototypes,
      releaseStats,
      visitStats,
    };
  }

  private async recentPrototypeItems(scope: ActorScope): Promise<RecentPrototypeItem[]> {
    const rows = await this.prototypes.recentUpdated(scope, RECENT_PROTOTYPE_LIMIT);
    const aggregates = await this.prototypes.aggregatesFor(rows);
    const baseUrl = this.appEnv.env.http.publicBaseUrl;
    return rows.map((row) => {
      const visits = aggregates.get(row.id.toString()) ?? createEmptyPrototypeAggregates();
      return {
        accessUrl: accessUrlOf(baseUrl, prototypeAccessPath(row.projectCode, row.code)),
        code: row.code,
        id: row.id.toString(),
        name: row.name,
        projectId: row.projectId.toString(),
        projectName: row.projectName,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
        visitsLast7d: visits.visitsLast7d,
      };
    });
  }

  private async recentEventItems(scope: ActorScope): Promise<RecentEventItem[]> {
    const rows = await this.versions.listRecentEvents(visiblePrototypes(scope), RECENT_EVENT_LIMIT);
    return rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      eventType: row.eventType,
      id: row.id.toString(),
      operatorName: row.operatorName,
      projectName: row.projectName,
      prototypeCode: row.prototypeCode,
      prototypeName: row.prototypeName,
      reason: row.reason,
    }));
  }
}

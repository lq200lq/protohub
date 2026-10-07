import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DashboardOverview } from '@protohub/shared';

import { RequirePermission } from '../../common/permission/require-permission.decorator';
import { ActorParam, type Actor } from '../system/common/actor';
import { DashboardService } from './dashboard.service';

/**
 * 工作台接口（后端接口设计 §3.1）。
 *
 * 只有 GET，没有查询参数：那张页要的就是"我这个人在我看得见的范围内的概览"，
 * 窗口（本周/今天/近 7 天）是契约的一部分，不开放给调用方改——改了就和访问记录页对不上了。
 * 响应体由全局 `SuccessEnvelopeInterceptor` 包信封，所以这里返回裸 payload。
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  @RequirePermission('dashboard:workspace:view')
  @ApiOperation({ summary: '工作台概览（受数据权限过滤）', operationId: 'dashboardOverview' })
  overview(@ActorParam() actor: Actor): Promise<DashboardOverview> {
    return this.service.overview(actor);
  }
}

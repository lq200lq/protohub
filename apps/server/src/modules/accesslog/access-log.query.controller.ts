import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessLogItem, AccessLogSummary, PageResult } from '@protohub/shared';

import { RequirePermission } from '../../common/permission/require-permission.decorator';
import { ActorParam, type Actor } from '../system/common/actor';
import { pageQueryFrom, parseWithSchema } from '../system/common/dto';
import {
  AccessLogQueryService,
  accessLogListQuerySchema,
  accessLogSummaryQuerySchema,
} from './access-log.query.service';

/**
 * 访问记录读接口（[后端接口设计.md](../../../../../docs/后端接口设计.md) §6.1/§6.2）。
 *
 * 权限码用的是 `proto:accesslog:list`：行里带访客 IP、UA、来源与登录用户名，属敏感数据，
 * 所以读侧同样挂码（§10 总表），与系统日志那两条一个取向。
 *
 * 路由顺序：`summary` 声明在列表之前。这两条本身不冲突（`@Get()` 只精确匹配 `/api/access-logs`），
 * 但 §6.3 的导出与将来的 `:id` 一旦补进来，`access-logs/summary` 就会被参数路由吃掉——
 * Nest 按声明顺序匹配，所以把静态段写在前面（同原型接口里 `check-code` 在 `:id` 之前那条要求）。
 */
@ApiTags('proto-accesslog')
@ApiBearerAuth()
@Controller('access-logs')
export class AccessLogQueryController {
  constructor(private readonly service: AccessLogQueryService) {}

  @Get('summary')
  @RequirePermission('proto:accesslog:list')
  @ApiOperation({
    summary: '访问记录汇总（PV/UV/拒绝/无效链接 + 按天趋势与两张榜）',
    operationId: 'protoAccessLogSummary',
  })
  summary(
    @ActorParam() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<AccessLogSummary> {
    const filter = parseWithSchema(accessLogSummaryQuerySchema, query);
    return this.service.summary(actor, filter);
  }

  @Get()
  @RequirePermission('proto:accesslog:list')
  @ApiOperation({
    summary: '访问记录分页明细（IP 默认打码，无效链接只剩 routeKey）',
    operationId: 'protoAccessLogList',
  })
  async list(
    @ActorParam() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<AccessLogItem>> {
    const filter = parseWithSchema(accessLogListQuerySchema, query);
    const data = await this.service.list(actor, filter, pageQueryFrom(query));
    return { items: [...data.items], total: data.total };
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { LoginLogItem, OperLogItem, PageResult } from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import { pageQueryFrom, parseWithSchema } from '../common/dto';
import { LogService } from './log.service';
import { loginLogQuerySchema, operLogQuerySchema } from './log.dto';

/**
 * 系统管理·日志接口（后端接口设计 §7.5）。
 * 读接口同样带权限码（§10 总表：两个日志接口都是 `system:log:list`）——日志里含用户名/IP/UA，属敏感数据。
 */
@ApiTags('system-log')
@ApiBearerAuth()
@Controller('system')
export class LogController {
  constructor(private readonly service: LogService) {}

  @Get('login-logs')
  @RequirePermission('system:log:list')
  @ApiOperation({ summary: '登录日志分页', operationId: 'systemLoginLogs' })
  async loginLogs(
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<LoginLogItem>> {
    const filter = parseWithSchema(loginLogQuerySchema, query);
    const data = await this.service.loginLogs(filter, pageQueryFrom(query));
    return { items: [...data.items], total: data.total };
  }

  @Get('oper-logs')
  @RequirePermission('system:log:list')
  @ApiOperation({ summary: '操作日志分页（detail 已脱敏）', operationId: 'systemOperLogs' })
  async operLogs(
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<OperLogItem>> {
    const filter = parseWithSchema(operLogQuerySchema, query);
    const data = await this.service.operLogs(filter, pageQueryFrom(query));
    return { items: [...data.items], total: data.total };
  }
}

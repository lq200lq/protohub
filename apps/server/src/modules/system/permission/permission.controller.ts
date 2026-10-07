import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PermissionDictGroup } from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import { PermissionDictService } from './permission-dict.service';

/**
 * 权限码字典接口（后端接口设计 §7.4）。
 * 权限码按 §7.4 的规定挂在 `system:role:list` 下——它只服务角色授权界面的勾选树，只做只读展示。
 */
@ApiTags('system-permission')
@ApiBearerAuth()
@Controller('system/permissions')
export class PermissionController {
  constructor(private readonly service: PermissionDictService) {}

  @Get()
  @RequirePermission('system:role:list')
  @ApiOperation({ summary: '按 module 分组的权限码字典（只读）', operationId: 'systemPermissionDict' })
  dict(): PermissionDictGroup[] {
    return this.service.dict();
  }
}

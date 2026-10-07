import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UploadTaskStatusResult } from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import { ActorParam, type Actor } from '../../system/common/actor';
import { UploadTaskService } from './task.service';

/**
 * §5.3 任务状态接口。
 *
 * 单开一个控制器而不是塞进 `ReleaseController`：受理是 `POST /api/releases`（一次性、写），
 * 这条是 `GET /api/upload-tasks/:id`（轮询、只读），两者的权限、频率与生命周期都不同——
 * 前端 1s 一次打它 120 次，不该和"上传 100MB"共用一个类的读法。
 */
@ApiTags('proto-release')
@ApiBearerAuth()
@Controller('upload-tasks')
export class UploadTaskController {
  constructor(private readonly service: UploadTaskService) {}

  @Get(':id')
  @RequirePermission('proto:prototype:publish')
  @ApiOperation({
    summary: '发布任务状态（进度/阶段/警告/失败详情；前端 1s 轮询到终态）',
    operationId: 'protoUploadTaskStatus',
  })
  status(@ActorParam() actor: Actor, @Param('id') id: string): Promise<UploadTaskStatusResult> {
    return this.service.status(actor, id);
  }
}

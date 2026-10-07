import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  PageResult,
  ProjectEventItem,
  PrototypeDetail,
  ReleaseEventItem,
  ReleaseListItem,
} from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../../system/common/actor';
import { zodValidationPipe } from '../../system/common/dto';
import { rollbackSchema, type RollbackInput } from './version.dto';
import { VersionService } from './version.service';

/**
 * 版本接口（后端接口设计 §5.4–§5.8）。
 *
 * 控制器用 `@Controller()` 空前缀 + 完整子路径，而不是拆成两个类：这五条路由分属
 * `prototypes/...` 与 `projects/...` 两种前缀，固定任一前缀都得为剩下的那条另开一个类——
 * 两个类各管半张版本视图，读代码的人反而要跳两处才知道"版本这一层暴露了什么"。
 * 与 `PrototypeController`/`ProjectController` 也不会互相遮蔽：它们的子路径最多两段（`:id/policy`），
 * 这里全部三段以上，段数不同就不存在"先注册的抢先匹配"。
 */
@ApiTags('proto-release')
@ApiBearerAuth()
@Controller()
export class VersionController {
  constructor(private readonly service: VersionService) {}

  @Get('prototypes/:id/releases')
  @RequirePermission('proto:release:list')
  @ApiOperation({ summary: '版本列表（原型内序号，当前生效版本带 isCurrent）', operationId: 'protoReleaseList' })
  async list(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<ReleaseListItem>> {
    return this.service.list(actor, id, query);
  }

  @Post('prototypes/:id/rollback')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proto:prototype:rollback')
  @ApiOperation({
    summary: '回滚到指定版本（只影响这一个原型的链接）',
    operationId: 'protoPrototypeRollback',
  })
  rollback(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(rollbackSchema)) input: RollbackInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeDetail> {
    return this.service.rollback(actor, id, input, request);
  }

  @Delete('prototypes/:id/releases/:releaseId')
  @RequirePermission('proto:release:delete')
  @ApiOperation({ summary: '删除版本（当前生效版本不允许删）', operationId: 'protoReleaseDelete' })
  async remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Param('releaseId') releaseId: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<void> {
    await this.service.removeRelease(actor, id, releaseId, request);
  }

  @Get('prototypes/:id/events')
  @RequirePermission('proto:release:list')
  @ApiOperation({ summary: '版本时间线（发布/回滚/强制重发/下架/删除版本）', operationId: 'protoReleaseEvents' })
  async prototypeEvents(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<ReleaseEventItem>> {
    return this.service.prototypeEvents(actor, id, query);
  }

  /**
   * §5.8 末段的项目级动态。权限按 §10 的总表挂 `proto:project:read`（项目详情页的那块折叠面板），
   * 同时接受 `proto:release:list`——总表把 5.8 也列在后者名下。`@RequirePermission` 是 OR，
   * 两枚码任一即可；能不能看见这个项目仍由数据范围判定（§6.2）。
   */
  @Get('projects/:id/events')
  @RequirePermission('proto:project:read', 'proto:release:list')
  @ApiOperation({ summary: '项目级动态（该项目下所有原型的版本事件）', operationId: 'protoProjectEvents' })
  async projectEvents(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<ProjectEventItem>> {
    return this.service.projectEvents(actor, id, query);
  }
}

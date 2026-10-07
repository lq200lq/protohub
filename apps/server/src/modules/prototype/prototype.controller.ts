import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CodeCheckResult,
  PageResult,
  PrototypeDetail,
  PrototypeListItem,
  PrototypeUpdateResult,
} from '@protohub/shared';

import { RequirePermission } from '../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../system/common/actor';
import { pageQueryFrom, parseWithSchema, zodValidationPipe } from '../system/common/dto';
import {
  createPrototypeSchema,
  prototypeCodeQuerySchema,
  prototypeListQuerySchema,
  setPrototypePolicySchema,
  updatePrototypeSchema,
  type CreatePrototypeInput,
  type PrototypeListFilter,
  type SetPrototypePolicyInput,
  type UpdatePrototypeInput,
} from './prototype.dto';
import { PrototypeService } from './prototype.service';

/**
 * 原型接口（后端接口设计 §4.3/§4.4）。
 *
 * `check-code` 声明在 `:id` 之前（与项目接口同一条路由顺序要求）；
 * 列表必填 projectId 由 `prototypeListQuerySchema` 保证，缺它直接 400，而不是返回全库原型。
 */
@ApiTags('proto-prototype')
@ApiBearerAuth()
@Controller('prototypes')
export class PrototypeController {
  constructor(private readonly service: PrototypeService) {}

  @Get()
  @RequirePermission('proto:prototype:list')
  @ApiOperation({ summary: '原型分页列表（必须带 projectId）', operationId: 'protoPrototypeList' })
  async list(
    @ActorParam() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<PrototypeListItem>> {
    const filter = parseWithSchema(prototypeListQuerySchema, query) as PrototypeListFilter;
    const data = await this.service.list(actor, filter, pageQueryFrom(query));
    return { items: [...data.items], total: data.total };
  }

  @Get('check-code')
  @RequirePermission('proto:prototype:create')
  @ApiOperation({
    summary: '原型编码可用性校验（项目内唯一；留空返回将生成的编码）',
    operationId: 'protoPrototypeCheckCode',
  })
  checkCode(
    @ActorParam() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<CodeCheckResult> {
    const { projectId, code } = parseWithSchema(prototypeCodeQuerySchema, query);
    return this.service.checkCode(actor, projectId, code);
  }

  @Post()
  @RequirePermission('proto:prototype:create')
  @ApiOperation({ summary: '新建草稿原型（code 留空由服务端生成）', operationId: 'protoPrototypeCreate' })
  create(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(createPrototypeSchema)) input: CreatePrototypeInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeDetail> {
    return this.service.create(actor, input, request);
  }

  @Get(':id')
  @RequirePermission('proto:prototype:read')
  @ApiOperation({ summary: '原型详情（含访问地址与策略）', operationId: 'protoPrototypeDetail' })
  detail(@ActorParam() actor: Actor, @Param('id') id: string): Promise<PrototypeDetail> {
    return this.service.detail(actor, id);
  }

  @Put(':id')
  @RequirePermission('proto:prototype:update')
  @ApiOperation({
    summary: '编辑原型（code 不可改，传了回 PROTO_CODE_IMMUTABLE 警告）',
    operationId: 'protoPrototypeUpdate',
  })
  update(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(updatePrototypeSchema)) input: UpdatePrototypeInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeUpdateResult> {
    return this.service.update(actor, id, input, request);
  }

  @Delete(':id')
  @RequirePermission('proto:prototype:delete')
  @ApiOperation({ summary: '删除原型（软删，级联其全部版本产物）', operationId: 'protoPrototypeDelete' })
  async remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<void> {
    await this.service.remove(actor, id, request);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proto:prototype:archive')
  @ApiOperation({
    summary: '归档原型（仅该原型链接不可访问）',
    operationId: 'protoPrototypeArchive',
  })
  archive(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeDetail> {
    return this.service.setArchived(actor, id, true, request);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proto:prototype:archive')
  @ApiOperation({ summary: '恢复上架', operationId: 'protoPrototypeUnarchive' })
  unarchive(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeDetail> {
    return this.service.setArchived(actor, id, false, request);
  }

  @Put(':id/policy')
  @RequirePermission('proto:prototype:policy')
  @ApiOperation({
    summary: '改访问策略（改模式/改密码会 policy_version + 1，旧解锁 Cookie 立即失效）',
    operationId: 'protoPrototypePolicy',
  })
  setPolicy(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(setPrototypePolicySchema)) input: SetPrototypePolicyInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<PrototypeDetail> {
    return this.service.setPolicy(actor, id, input, request);
  }
}

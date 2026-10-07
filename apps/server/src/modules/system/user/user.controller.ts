import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateUserResult,
  PageResult,
  ResetUserPasswordResult,
  UserDetail,
  UserListItem,
} from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../common/actor';
import { pageQueryFrom, parseWithSchema, zodValidationPipe } from '../common/dto';
import {
  assignRolesSchema,
  createUserSchema,
  setUserStatusSchema,
  updateUserSchema,
  userListQuerySchema,
  type AssignRolesInput,
  type CreateUserInput,
  type SetUserStatusInput,
  type UpdateUserInput,
} from './user.dto';
import { UserService } from './user.service';

/**
 * 系统管理·用户接口（后端接口设计 §7.1）。
 *
 * 权限码逐条对齐 §7.1 表格与 §10 总表；**没有一条写接口是裸的**（计划 §8 F-4 的自检项）。
 * `@ActorParam()` 之所以是必填：审计要记 who，C-3/C-4 的判定也要看操作者身份。
 */
@ApiTags('system-user')
@ApiBearerAuth()
@Controller('system/users')
export class UserController {
  constructor(private readonly service: UserService) {}

  @Get()
  @RequirePermission('system:user:list')
  @ApiOperation({ summary: '用户分页列表', operationId: 'systemUserList' })
  async list(
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<UserListItem>> {
    const filter = parseWithSchema(userListQuerySchema, query);
    const data = await this.service.list(filter, pageQueryFrom(query));
    // PageData.items 是 readonly（服务层不打算再改它），对外契约按 §1.3 的 PageResult 展开一份。
    return { items: [...data.items], total: data.total };
  }

  @Get(':id')
  @RequirePermission('system:user:read')
  @ApiOperation({ summary: '用户详情（含角色与数据范围）', operationId: 'systemUserDetail' })
  detail(@Param('id') id: string): Promise<UserDetail> {
    return this.service.detail(id);
  }

  @Post()
  @RequirePermission('system:user:create')
  @ApiOperation({
    summary: '新建用户（初始密码随机生成，仅本响应返回一次且不写日志）',
    operationId: 'systemUserCreate',
  })
  create(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(createUserSchema)) input: CreateUserInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<CreateUserResult> {
    return this.service.create(actor, input, request);
  }

  @Put(':id')
  @RequirePermission('system:user:update')
  @ApiOperation({ summary: '编辑用户（username 不可改）', operationId: 'systemUserUpdate' })
  update(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(updateUserSchema)) input: UpdateUserInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<UserDetail> {
    return this.service.update(actor, id, input, request);
  }

  @Put(':id/status')
  @RequirePermission('system:user:update')
  @ApiOperation({ summary: '启用/停用用户', operationId: 'systemUserSetStatus' })
  setStatus(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(setUserStatusSchema)) input: SetUserStatusInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<UserDetail> {
    return this.service.setStatus(actor, id, input.status, request);
  }

  @Delete(':id')
  @RequirePermission('system:user:delete')
  @ApiOperation({ summary: '删除用户（软删除，C-2/C-3 生效）', operationId: 'systemUserDelete' })
  remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<{ id: string }> {
    return this.service.remove(actor, id, request);
  }

  @Put(':id/password')
  @RequirePermission('system:user:resetpwd')
  @ApiOperation({
    summary: '重置密码（随机新密码只返回一次，该用户全部会话失效）',
    operationId: 'systemUserResetPassword',
  })
  resetPassword(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ResetUserPasswordResult> {
    return this.service.resetPassword(actor, id, request);
  }

  @Put(':id/roles')
  @RequirePermission('system:user:assignrole')
  @ApiOperation({ summary: '覆盖式分配角色（C-4 生效）', operationId: 'systemUserAssignRoles' })
  assignRoles(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(assignRolesSchema)) input: AssignRolesInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<UserDetail> {
    return this.service.assignRoles(actor, id, input, request);
  }
}

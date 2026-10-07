import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RoleDetail, RoleListItem } from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../common/actor';
import { zodValidationPipe } from '../common/dto';
import {
  assignRolePermissionsSchema,
  createRoleSchema,
  updateRoleSchema,
  type AssignRolePermissionsInput,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './role.dto';
import { RoleService } from './role.service';

/**
 * 系统管理·角色接口（后端接口设计 §7.2）。
 * 权限码逐条对齐 §7.2 表格与 §10 总表；**没有一条写接口是裸的**（计划 §8 F-4 的自检项）。
 */
@ApiTags('system-role')
@ApiBearerAuth()
@Controller('system/roles')
export class RoleController {
  constructor(private readonly service: RoleService) {}

  @Get()
  @RequirePermission('system:role:list')
  @ApiOperation({ summary: '角色全量列表（含 userCount，不分页）', operationId: 'systemRoleList' })
  async list(): Promise<RoleListItem[]> {
    return this.service.list();
  }

  @Get(':id')
  @RequirePermission('system:role:read')
  @ApiOperation({ summary: '角色详情（含权限码与菜单）', operationId: 'systemRoleDetail' })
  detail(@Param('id') id: string): Promise<RoleDetail> {
    return this.service.detail(id);
  }

  @Post()
  @RequirePermission('system:role:create')
  @ApiOperation({ summary: '新建角色', operationId: 'systemRoleCreate' })
  create(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(createRoleSchema)) input: CreateRoleInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<RoleListItem> {
    return this.service.create(actor, input, request);
  }

  @Put(':id')
  @RequirePermission('system:role:update')
  @ApiOperation({ summary: '编辑角色（内置角色 code 不可改，C-1）', operationId: 'systemRoleUpdate' })
  update(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(updateRoleSchema)) input: UpdateRoleInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<RoleDetail> {
    return this.service.update(actor, id, input, request);
  }

  @Delete(':id')
  @RequirePermission('system:role:delete')
  @ApiOperation({ summary: '删除角色（软删除；内置不可删、有用户绑定 400）', operationId: 'systemRoleDelete' })
  remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<{ id: string }> {
    return this.service.remove(actor, id, request);
  }

  @Put(':id/permissions')
  @RequirePermission('system:role:assignperm')
  @ApiOperation({
    summary: '覆盖式分配权限码与菜单（保存后即时失效该角色用户的权限缓存）',
    operationId: 'systemRoleAssignPermissions',
  })
  assignPermissions(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(assignRolePermissionsSchema)) input: AssignRolePermissionsInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<RoleDetail> {
    return this.service.assignPermissions(actor, id, input, request);
  }
}

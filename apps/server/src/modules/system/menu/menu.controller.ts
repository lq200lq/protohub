import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MenuTreeNode } from '@protohub/shared';

import { RequirePermission } from '../../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../common/actor';
import { zodValidationPipe } from '../common/dto';
import {
  menuFormSchema,
  setMenuStatusSchema,
  type MenuFormInput,
  type SetMenuStatusInput,
} from './menu.dto';
import { MenuService } from './menu.service';

/**
 * 系统管理·菜单接口（后端接口设计 §7.3）。
 * 启停（PUT :id/status）是 §7.3.3 表单 status 的动作化快捷路径，权限码同 update（§10 总表无新增码）。
 */
@ApiTags('system-menu')
@ApiBearerAuth()
@Controller('system/menus')
export class MenuController {
  constructor(private readonly service: MenuService) {}

  @Get()
  @RequirePermission('system:menu:list')
  @ApiOperation({ summary: '菜单树（含 button 节点，不分页）', operationId: 'systemMenuTree' })
  async tree(): Promise<MenuTreeNode[]> {
    return this.service.tree();
  }

  @Post()
  @RequirePermission('system:menu:create')
  @ApiOperation({ summary: '新建菜单/按钮', operationId: 'systemMenuCreate' })
  create(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(menuFormSchema)) input: MenuFormInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<MenuTreeNode> {
    return this.service.create(actor, input, request);
  }

  @Put(':id/status')
  @RequirePermission('system:menu:update')
  @ApiOperation({ summary: '启用/停用菜单（停用后不再下发给前端路由）', operationId: 'systemMenuSetStatus' })
  setStatus(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(setMenuStatusSchema)) input: SetMenuStatusInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<MenuTreeNode> {
    return this.service.setStatus(actor, id, input.status, request);
  }

  @Put(':id')
  @RequirePermission('system:menu:update')
  @ApiOperation({ summary: '编辑菜单/按钮', operationId: 'systemMenuUpdate' })
  update(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(menuFormSchema)) input: MenuFormInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<MenuTreeNode> {
    return this.service.update(actor, id, input, request);
  }

  @Delete(':id')
  @RequirePermission('system:menu:delete')
  @ApiOperation({ summary: '删除菜单（有子节点 400 MENU_HAS_CHILDREN）', operationId: 'systemMenuDelete' })
  remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<{ id: string }> {
    return this.service.remove(actor, id, request);
  }
}

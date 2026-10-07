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
  ProjectDetail,
  ProjectListItem,
  ProjectMemberItem,
  ProjectUpdateResult,
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
  createProjectSchema,
  projectCodeQuerySchema,
  projectListQuerySchema,
  setProjectMembersSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type ProjectListFilter,
  type SetProjectMembersInput,
  type UpdateProjectInput,
} from './project.dto';
import { ProjectService } from './project.service';

/**
 * 项目接口（后端接口设计 §4.1/§4.2）。
 *
 * 路由顺序有硬要求：`check-code` 必须声明在 `:id` 之前，否则 `GET /api/projects/check-code`
 * 会先进详情接口，把一个非数字 id 报成 400（Gate G6 的 curl 就会打在那里）。
 */
@ApiTags('proto-project')
@ApiBearerAuth()
@Controller('projects')
export class ProjectController {
  constructor(private readonly service: ProjectService) {}

  @Get()
  @RequirePermission('proto:project:list')
  @ApiOperation({ summary: '项目分页列表', operationId: 'protoProjectList' })
  async list(
    @ActorParam() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<PageResult<ProjectListItem>> {
    const filter = parseWithSchema(projectListQuerySchema, query) as ProjectListFilter;
    const data = await this.service.list(actor, filter, pageQueryFrom(query));
    return { items: [...data.items], total: data.total };
  }

  @Get('check-code')
  @RequirePermission('proto:project:create')
  @ApiOperation({
    summary: '项目编码可用性校验（留空返回将生成的候选码）',
    operationId: 'protoProjectCheckCode',
  })
  checkCode(@Query() query: Record<string, unknown>): Promise<CodeCheckResult> {
    const { code } = parseWithSchema(projectCodeQuerySchema, query);
    return this.service.checkCode(code);
  }

  @Post()
  @RequirePermission('proto:project:create')
  @ApiOperation({ summary: '新建项目（code 留空由服务端生成）', operationId: 'protoProjectCreate' })
  create(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(createProjectSchema)) input: CreateProjectInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.service.create(actor, input, request);
  }

  @Get(':id')
  @RequirePermission('proto:project:read')
  @ApiOperation({ summary: '项目详情（含原型计数明细与成员数）', operationId: 'protoProjectDetail' })
  detail(@ActorParam() actor: Actor, @Param('id') id: string): Promise<ProjectDetail> {
    return this.service.detail(actor, id);
  }

  @Put(':id')
  @RequirePermission('proto:project:update')
  @ApiOperation({
    summary: '编辑项目（code 传了不生效，回 PROTO_CODE_IMMUTABLE 警告）',
    operationId: 'protoProjectUpdate',
  })
  update(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(updateProjectSchema)) input: UpdateProjectInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ProjectUpdateResult> {
    return this.service.update(actor, id, input, request);
  }

  @Delete(':id')
  @RequirePermission('proto:project:delete')
  @ApiOperation({ summary: '删除项目（软删，级联其下原型）', operationId: 'protoProjectDelete' })
  async remove(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<void> {
    await this.service.remove(actor, id, request);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proto:project:archive')
  @ApiOperation({
    summary: '归档项目（其下所有原型链接立即返回已下架页）',
    operationId: 'protoProjectArchive',
  })
  archive(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.service.setArchived(actor, id, true, request);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('proto:project:archive')
  @ApiOperation({ summary: '恢复上架', operationId: 'protoProjectUnarchive' })
  unarchive(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ProjectDetail> {
    return this.service.setArchived(actor, id, false, request);
  }

  @Get(':id/members')
  @RequirePermission('proto:project:read')
  @ApiOperation({ summary: '成员列表', operationId: 'protoProjectMembers' })
  members(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
  ): Promise<ProjectMemberItem[]> {
    return this.service.members(actor, id);
  }

  @Put(':id/members')
  @RequirePermission('proto:project:update')
  @ApiOperation({
    summary: '覆盖式设置成员（创建人的 owner 不被抹掉）',
    operationId: 'protoProjectSetMembers',
  })
  setMembers(
    @ActorParam() actor: Actor,
    @Param('id') id: string,
    @Body(zodValidationPipe(setProjectMembersSchema)) input: SetProjectMembersInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<ProjectMemberItem[]> {
    return this.service.setMembers(actor, id, input, request);
  }
}

import { Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ReleaseAcceptedResult, ReleaseLinkPreviewResult } from '@protohub/shared';

import { RequirePermission } from '../../common/permission/require-permission.decorator';
import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../system/common/actor';
import { parseWithSchema } from '../system/common/dto';
import { linkPreviewQuerySchema } from './release.dto';
import { ReleaseService, type ReleaseRequest } from './release.service';

/**
 * 发布受理接口（后端接口设计 §5.1）。
 *
 * 这里**不用 `@Body()`**：multipart 的正文要在请求生命周期里流式写盘（§5.2 明确禁止在受理时解压），
 * 让 Nest/fastify 先把整体读成对象就等于把 100MB 搬进内存。控制器只交出请求本身，
 * 收字段、收文件、判超限全在 `pipeline/intake.ts`。
 *
 * 权限标注只写 `publish`：`@RequirePermission` 是 OR 语义，而"顺带新建项目/原型"要的是 AND，
 * 那两枚码由服务层按场景叠加判定（§5.1 的字段表）。
 */
@ApiTags('proto-release')
@ApiBearerAuth()
@Controller('releases')
export class ReleaseController {
  constructor(private readonly service: ReleaseService) {}

  @Post()
  @HttpCode(202)
  @RequirePermission('proto:prototype:publish')
  @ApiOperation({
    summary: '上传 HTML zip 并发布（三合一：追加版本 / 新建原型 / 新建项目+原型）',
    operationId: 'protoReleaseCreate',
  })
  accept(
    @Req() request: ReleaseRequest,
    @ActorParam() actor: Actor,
    @RequestMetaParam() meta: RequestMeta,
  ): Promise<ReleaseAcceptedResult> {
    return this.service.accept(request, actor, meta);
  }

  @Get('link-preview')
  @RequirePermission('proto:prototype:publish')
  @ApiOperation({
    summary: '发布前的访问链接预览（URL 由服务端拼装，界面不各写一遍域名）',
    operationId: 'protoReleaseLinkPreview',
  })
  linkPreview(@Query() query: Record<string, unknown>): ReleaseLinkPreviewResult {
    const { projectCode, prototypeCode } = parseWithSchema(
      linkPreviewQuerySchema,
      query,
    );
    return this.service.linkPreview(projectCode, prototypeCode);
  }
}

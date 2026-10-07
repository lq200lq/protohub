import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserDetail } from '@protohub/shared';

import {
  ActorParam,
  RequestMetaParam,
  type Actor,
  type RequestMeta,
} from '../common/actor';
import { zodValidationPipe } from '../common/dto';
import {
  changePasswordSchema,
  updateProfileSchema,
  type ChangePasswordInput,
  type UpdateProfileInput,
} from './user.dto';
import { UserService } from './user.service';

/**
 * 个人中心（后端接口设计 §2.7 / §2.8）。
 *
 * 与 §7.1 的管理接口分属两个 controller：路径前缀不同（`/api/user/*` 而不是 `/api/system/users/*`），
 * 且**权限语义完全不同**——这一组只操作 `request.user` 自己的账号，§10 总表把它们列在
 * "仅需登录 | 2.3~2.8"，所以这里**刻意不挂** `@RequirePermission`：
 * 挂 `system:user:update` 会让"改自己的手机号"要求管理员权限，是功能错误；
 * 服务层也不接受 id 参数（一律用 actor.userId），因此不存在越权改别人的路径。
 * 这是计划 §8 F-4"写接口必须有权限声明"的唯一例外，例外依据是 §10 的这条表行，
 * 并由 route-inventory 测试显式白名单锁定（新增裸写接口会让测试失败）。
 *
 * 前缀 `user` 与 auth 模块的 `/user/info`、`/user/password` 无冲突：本 controller 只声明
 * `profile`（GET/PUT）与 `password`（PUT）；`GET /user/info` 由 auth 上下文实现（§2.5）。
 *
 * 响应形态：§2.7 写"响应 data 同 /user/info"，但那个形态里的 `homePath`/`desc` 由 auth 的
 * §2.5 装配逻辑决定（`UserInfo` 契约），system 模块重算一遍会出现两份真相。
 * 这里统一返回 `UserDetail`（含 §2.5 之外的 dataScope/remark，且 id 而非 userId），
 * 前端在改完资料后重新拉 `/user/info` 即可刷新顶栏（已记入交付报告的文档偏差项）。
 */
@ApiTags('user-profile')
@Controller('user')
export class UserProfileController {
  constructor(private readonly service: UserService) {}

  @Get('profile')
  @ApiOperation({
    summary: '本人资料（§2.7 的读侧；文档只写了 PUT，界面需要读回来渲染表单）',
    operationId: 'userProfileGet',
  })
  profile(@ActorParam() actor: Actor): Promise<UserDetail> {
    return this.service.profileOf(actor);
  }

  @Put('profile')
  @ApiOperation({ summary: '修改本人资料（realName/email/phone/avatar）', operationId: 'userProfileUpdate' })
  updateProfile(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(updateProfileSchema)) input: UpdateProfileInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<UserDetail> {
    return this.service.updateProfile(actor, input, request);
  }

  @Put('password')
  @ApiOperation({
    summary: '修改本人密码（强度校验 + token_version+1 + 清 force_password_change）',
    operationId: 'userPasswordChange',
  })
  async changePassword(
    @ActorParam() actor: Actor,
    @Body(zodValidationPipe(changePasswordSchema)) input: ChangePasswordInput,
    @RequestMetaParam() request: RequestMeta,
  ): Promise<null> {
    // 返回值恒为 null（§2.8 响应 data: null）。会话 Cookie 的清理由 auth 侧的
    // 响应拦截/前端重登录流程负责：token_version+1 已让所有旧令牌失效（§5.4）。
    await this.service.changePassword(actor, input, request);
    return null;
  }
}

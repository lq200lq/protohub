import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserInfo } from '@protohub/shared';

import { CurrentUser } from '../../common/decorator/current-user.decorator';
import type { AuthUser } from '../../common/permission/auth-user';
import { UserInfoService } from './user-info.service';

/**
 * `GET /api/user/info`（后端接口设计 §2.5，vben 强依赖）。
 *
 * 路径挂在 `/user` 而不是 `/system/users`：vben 的用户信息接口写死 `/user/info`；
 * 系统管理里的用户 CRUD 由 system 模块负责，两者不重叠。
 */
@ApiTags('user')
@Controller('user')
export class UserInfoController {
  constructor(private readonly userInfo: UserInfoService) {}

  @Get('info')
  @ApiOperation({ summary: '当前登录用户信息' })
  info(@CurrentUser() user: AuthUser): UserInfo {
    return this.userInfo.infoOf(user);
  }
}

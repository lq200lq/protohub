import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MenuRouteTree } from '@protohub/shared';

import { CurrentUser } from '../../common/decorator/current-user.decorator';
import type { AuthUser } from '../../common/permission/auth-user';
import { MenuService } from './menu.service';

/**
 * `GET /api/menu/all`（后端接口设计 §2.6）：vben 的 backend 访问模式用它生成动态路由。
 *
 * 只下发"启用 + 当前用户有权"的节点，并且剔除 `type='button'`（按钮权限走 `/auth/codes`），
 * 否则前端菜单树里会冒出一堆点不动的空节点。
 */
@ApiTags('menu')
@Controller('menu')
export class MenuController {
  constructor(private readonly menus: MenuService) {}

  @Get('all')
  @ApiOperation({ summary: '当前用户可见的路由树' })
  all(@CurrentUser() user: AuthUser): Promise<MenuRouteTree> {
    return this.menus.routesFor(user);
  }
}

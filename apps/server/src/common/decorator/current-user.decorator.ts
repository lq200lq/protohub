import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';

import { UnauthorizedException } from '../exception/business.exception';
import type { AuthUser } from '../permission/auth-user';

/**
 * 取 Guard 写进 `request.user` 的登录态。
 *
 * 拿不到就抛 401：只有 `@Public()` 路由会绕过 Guard，而这类参数只应出现在需要登录的接口上
 * ——真出现说明接线写错了，不能悄悄给个 null 让下游判空。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException(
        '请先登录',
        ERROR_CODES.AUTH_UNAUTHORIZED,
      );
    }
    return user;
  },
);

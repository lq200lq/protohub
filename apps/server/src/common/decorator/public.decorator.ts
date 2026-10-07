import { SetMetadata } from '@nestjs/common';

/** 标记"无需登录即可访问"的路由（如 /auth/login、/auth/refresh、/health）。 */
export const IS_PUBLIC_KEY = 'protohub:is-public';

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

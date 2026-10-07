import { SetMetadata } from '@nestjs/common';

/** 标记"这个路由自己决定响应形态，不要套统一信封"。 */
export const SKIP_ENVELOPE_KEY = 'protohub:skip-envelope';

/**
 * 后端接口设计.md §1.2：统一响应体的**唯一例外**是 `/auth/refresh`
 * （vben 实测那里要返回裸字符串），所以留一个显式的绕过口子。
 */
export const SkipEnvelope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_ENVELOPE_KEY, true);

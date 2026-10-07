import { describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../../common/exception/business.exception';
import { SKIP_ENVELOPE_KEY } from '../../common/response/skip-envelope.decorator';
import {
  createReplyCapture,
  createRequest,
} from '../../testing/nest-context.fixture';
import type {
  CookieReplyWriter,
} from '../../common/permission/cookie.service';
import { CookieService } from '../../common/permission/cookie.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';

/**
 * `/api/auth/refresh` 的响应形态契约（后端接口设计 §2.2；计划 §6.4 N3）。
 *
 * vben 的 `refreshTokenApi` 走的是**不挂响应拦截器**的 `baseRequestClient`，
 * 拿到什么就把什么当 token 拼进 `Authorization` 头。所以这里钉死三件事：
 * 返回值是**裸字符串**、`content-type` 是 `text/plain`、路由挂着 `@SkipEnvelope`
 * （统一信封 §1.2 的唯一例外）。谁把它改成 `{code,data}` 包装，前端刷新后所有请求头
 * 都会变成 `Bearer [object Object]`，页面全空（§6.5 F-1）。
 */
const TOKENS = {
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.smoke',
  expiresIn: 900,
  refreshExpiresIn: 604_800,
};

function harness(options: { refresh?: () => Promise<unknown> } = {}) {
  const authService = {
    refresh: options.refresh ?? (async () => TOKENS),
  } as unknown as AuthService;
  const sessions = {
    clearAuthCookies: vi.fn(),
    writeAuthCookies: vi.fn(),
  } as unknown as AuthSessionService;
  const cookies = {
    read: () => 'raw-refresh-cookie',
  } as unknown as CookieService;
  const controller = new AuthController(authService, sessions, cookies);
  return { controller, sessions };
}

function reply(): CookieReplyWriter {
  return createReplyCapture().reply as unknown as CookieReplyWriter;
}

describe('AuthController /auth/refresh 响应形态', () => {
  it('成功：返回值是裸 token 字符串，不是 {code,data} 信封', async () => {
    const { controller, sessions } = harness();
    const result = await controller.refresh(createRequest(), reply());
    expect(result).toBe(TOKENS.accessToken);
    expect(typeof result).toBe('string');
    expect(sessions.writeAuthCookies).toHaveBeenCalledTimes(1);
  });

  it('content-type 是 text/plain（信封才是 application/json）', async () => {
    const { controller } = harness();
    const capture = createReplyCapture();
    await controller.refresh(
      createRequest(),
      capture.reply as unknown as CookieReplyWriter,
    );
    expect(capture.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('挂着 @SkipEnvelope：统一信封的唯一例外', () => {
    const { controller } = harness();
    const meta = Reflect.getMetadata(SKIP_ENVELOPE_KEY, controller.refresh);
    expect(meta).toBe(true);
  });

  it('刷新失败：错误照样抛出去（不能变成 200 信封），并顺手清 Cookie', async () => {
    const { controller, sessions } = harness({
      refresh: async () => {
        throw new BusinessException('refresh 无效', 'AUTH_UNAUTHORIZED', 401);
      },
    });
    await expect(
      controller.refresh(createRequest(), reply()),
    ).rejects.toThrow(BusinessException);
    expect(sessions.clearAuthCookies).toHaveBeenCalledTimes(1);
  });
});

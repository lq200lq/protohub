import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, type AuthCodes, type LoginParams, type LoginResult } from '@protohub/shared';
import { z } from 'zod';

import { CurrentUser } from '../../common/decorator/current-user.decorator';
import { Public } from '../../common/decorator/public.decorator';
import type { AuthUser } from '../../common/permission/auth-user';
import type { CookieReplyWriter } from '../../common/permission/cookie.service';
import {
  CookieService,
  REFRESH_COOKIE_NAME,
} from '../../common/permission/cookie.service';
import { BusinessException } from '../../common/exception/business.exception';
import { SkipEnvelope } from '../../common/response/skip-envelope.decorator';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';
import { clientMetaOf, type ClientRequestLike } from './client-request';

/** 用户名/密码长度上限：拦住"拿 10MB 当密码"这类把 argon2 变 DoS 工具的输入。 */
const loginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

function parseLoginBody(body: unknown): LoginParams {
  const parsed = loginBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BusinessException(
      '用户名与密码都要填，且长度不能超限',
      ERROR_CODES.PARAM_INVALID,
      HttpStatus.BAD_REQUEST,
    );
  }
  return { username: parsed.data.username, password: parsed.data.password };
}

/**
 * 认证接口（后端接口设计 §2）。这一组是 vben 写死调用的，
 * 路径、字段名、以及 refresh 的**裸字符串**返回形态都不能改。
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: AuthSessionService,
    private readonly cookies: CookieService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登录', description: '返回 data.accessToken，并下发两个 HttpOnly Cookie' })
  async login(
    @Body() body: unknown,
    @Req() request: ClientRequestLike,
    @Res({ passthrough: true }) reply: CookieReplyWriter,
  ): Promise<LoginResult> {
    const input = parseLoginBody(body);
    const { user, tokens } = await this.authService.login({
      ...input,
      ...clientMetaOf(request),
    });
    this.sessions.writeAuthCookies(reply, tokens);
    return user;
  }

  /**
   * 刷新：`@SkipEnvelope()` + 直接返回字符串。
   *
   * vben 的 `refreshTokenApi` 走的是不挂响应拦截器的 `baseRequestClient`，
   * 取的是 `resp.data`（= 整个响应体）。这里一旦被套上 `{code,data}`，
   * 前端会把整个对象当 token 用，之后所有请求头变成 `Bearer [object Object]`。
   */
  @Public()
  @SkipEnvelope()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '刷新 accessToken',
    description: '成功返回裸字符串（text/plain），这是统一响应体的唯一例外',
  })
  async refresh(
    @Req() request: ClientRequestLike,
    @Res({ passthrough: true }) reply: CookieReplyWriter,
  ): Promise<string> {
    const raw = this.cookies.read(request, REFRESH_COOKIE_NAME);
    let accessToken: string;
    try {
      const tokens = await this.authService.refresh(raw, clientMetaOf(request));
      this.sessions.writeAuthCookies(reply, tokens);
      accessToken = tokens.accessToken;
    } catch (error: unknown) {
      // §2.2：刷新失败要顺手清 Cookie，浏览器里不能留下一个已经被判死的 refresh。
      this.sessions.clearAuthCookies(reply);
      throw error;
    }
    reply.header('content-type', 'text/plain; charset=utf-8');
    return accessToken;
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '登出', description: '记登录日志并清两个 Cookie' })
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() request: ClientRequestLike,
    @Res({ passthrough: true }) reply: CookieReplyWriter,
  ): Promise<null> {
    await this.authService.logout(user, clientMetaOf(request));
    this.sessions.clearAuthCookies(reply);
    return null;
  }

  @Get('codes')
  @ApiOperation({ summary: '当前用户权限码', description: 'super_admin 返回全集' })
  codes(@CurrentUser() user: AuthUser): Promise<AuthCodes> {
    return this.authService.codesOf(user);
  }
}

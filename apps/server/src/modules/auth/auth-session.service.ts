import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, USER_STATUS_ENABLED } from '@protohub/shared';

import type { Account } from '../../common/permission/account.service';
import { AccountService } from '../../common/permission/account.service';
import type { CookieReplyWriter } from '../../common/permission/cookie.service';
import { CookieService } from '../../common/permission/cookie.service';
import { BusinessException } from '../../common/exception/business.exception';
import { JwtTokenService } from '../../common/permission/jwt-token.service';
import { SessionService } from '../../common/permission/session.service';
import type { ClientMeta } from './client-request';
import { LoginLogService } from './login-log.service';

/** 一次登录/刷新下发的全套凭据。 */
export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionToken: string;
}

/**
 * 凭据的签发与刷新。
 *
 * 单独成一个服务是因为它有两个调用方：`/auth/login` 首发、`/auth/refresh` 轮转，
 * 两处必须签发同一套东西（accessToken + 两个 Cookie），漏一个就会出现
 * "刷新之后 member 档原型突然打不开"这类极难复现的问题。
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    private readonly accounts: AccountService,
    private readonly tokens: JwtTokenService,
    private readonly sessions: SessionService,
    private readonly loginLogs: LoginLogService,
    private readonly cookies: CookieService,
  ) {}

  issueFor(account: Account): AuthTokens {
    return {
      accessToken: this.tokens.signAccessToken({
        userId: account.userId,
        username: account.username,
        tokenVersion: account.tokenVersion,
      }),
      refreshToken: this.tokens.signRefreshToken({
        userId: account.userId,
        tokenVersion: account.tokenVersion,
      }),
      // token_version 编进会话 Cookie：改密/被禁用后旧 Cookie 立刻失效（权限模型设计 §5.4）。
      sessionToken: this.sessions.issue(account.userId, account.tokenVersion),
    };
  }

  /**
   * 用 `proto_refresh` Cookie 换一套新凭据（轮转：两个 Cookie 都重发）。
   *
   * 失败一律 403 + `AUTH_REFRESH_INVALID`（后端接口设计 §2.2），**不能返 401**：
   * 返 401 会让前端的刷新拦截器以为"再刷一次就好了"，变成刷新风暴。
   */
  async refresh(
    rawRefreshToken: string | undefined,
    meta: ClientMeta,
  ): Promise<AuthTokens> {
    if (!rawRefreshToken) {
      await this.reject('missing_refresh_cookie', null, meta);
      throw refreshInvalid();
    }
    let userId: string;
    let tokenVersion: number;
    try {
      const claims = this.tokens.verifyRefreshToken(rawRefreshToken);
      userId = claims.sub;
      tokenVersion = claims.tv;
    } catch (error: unknown) {
      await this.reject(
        error instanceof Error ? error.message : 'invalid_refresh_token',
        null,
        meta,
      );
      throw refreshInvalid();
    }
    const account = await this.accounts.loadById(userId);
    if (
      !account ||
      account.status !== USER_STATUS_ENABLED ||
      account.tokenVersion !== tokenVersion
    ) {
      // 库里已经不留这个会话了；日志仍记下被拒的 sub，便于排查"谁在拿旧 cookie 试"。
      await this.reject('account_state_rejected', userId, meta);
      throw refreshInvalid();
    }
    return this.issueFor(account);
  }

  /** 登录/刷新成功后下发两个 HttpOnly Cookie。 */
  writeAuthCookies(reply: CookieReplyWriter, tokens: AuthTokens): void {
    this.cookies.issueAuthCookies(reply, {
      refreshToken: tokens.refreshToken,
      sessionToken: tokens.sessionToken,
      refreshMaxAgeSeconds: this.tokens.refreshTokenTtlSeconds,
      sessionMaxAgeSeconds: this.sessions.ttlSeconds,
    });
  }

  clearAuthCookies(reply: CookieReplyWriter): void {
    this.cookies.clearAuthCookies(reply);
  }

  private async reject(
    reason: string,
    userId: string | null,
    meta: ClientMeta,
  ): Promise<void> {
    this.logger.warn({ reason, userId }, '刷新令牌被拒绝');
    await this.loginLogs.record({
      userId,
      username: userId ?? 'unknown',
      loginType: 'refresh_fail',
      success: false,
      failReason: reason,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}

function refreshInvalid(): BusinessException {
  return new BusinessException(
    '登录状态已失效，请重新登录',
    ERROR_CODES.AUTH_REFRESH_INVALID,
    HttpStatus.FORBIDDEN,
  );
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import {
  ERROR_CODES,
  USER_STATUS_ENABLED,
  type AuthCodes,
  type LoginResult,
} from '@protohub/shared';
import { verify as verifyArgon2 } from 'argon2';

import { SUPER_ADMIN_ROLE } from '../../common/permission/account.service';
import type { Account } from '../../common/permission/account.service';
import { AccountService } from '../../common/permission/account.service';
import type { AuthUser } from '../../common/permission/auth-user';
import { UnauthorizedException } from '../../common/exception/business.exception';
import { PermissionCodeService } from '../../common/permission/permission-code.service';
import { PRISMA_CLIENT } from '../../common/permission/prisma-client';
import { HOME_PATH } from './auth.constants';
import type { AuthTokens } from './auth-session.service';
import { AuthSessionService } from './auth-session.service';
import type { ClientMeta } from './client-request';
import { LoginLogService } from './login-log.service';
import { LoginLockService } from './login-lock.service';

export interface LoginInput extends ClientMeta {
  readonly username: string;
  readonly password: string;
}

export interface LoginOutcome {
  readonly user: LoginResult;
  readonly tokens: AuthTokens;
}

const BAD_CREDENTIALS_MESSAGE = '用户名或密码不正确';

function toUserId(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * 登录 / 登出 / 权限码。
 *
 * 失败原因的先后顺序（用户名不存在 → 密码错 → 已禁用）是**刻意**的：前两种对外给同一个
 * `AUTH_BAD_CREDENTIALS`，避免未登录者靠返回码差异枚举"哪些用户名真实存在"。
 * 禁用要单独报（§2.1 要求 `AUTH_DISABLED`），所以放在密码之后——只有真的知道密码的人
 * 才能看到"账号已被停用"这条信息。
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly accounts: AccountService,
    private readonly sessions: AuthSessionService,
    private readonly lock: LoginLockService,
    private readonly loginLogs: LoginLogService,
    private readonly permissionCodes: PermissionCodeService,
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
  ) {}

  async login(input: LoginInput): Promise<LoginOutcome> {
    // 429 放在最前面：被锁定时连密码校验都不做（§1.4 的限速语义）。
    await this.lock.assertNotLocked(input.username, input.ip);

    const account = await this.accounts.loadByUsername(input.username);
    if (!account) {
      await this.recordFailedLogin(input, null, 'user_not_found');
      throw new UnauthorizedException(
        BAD_CREDENTIALS_MESSAGE,
        ERROR_CODES.AUTH_BAD_CREDENTIALS,
      );
    }
    if (!(await this.passwordMatches(account, input.password))) {
      await this.recordFailedLogin(input, account.userId, 'bad_password');
      throw new UnauthorizedException(
        BAD_CREDENTIALS_MESSAGE,
        ERROR_CODES.AUTH_BAD_CREDENTIALS,
      );
    }
    if (account.status !== USER_STATUS_ENABLED) {
      await this.recordFailedLogin(input, account.userId, 'user_disabled');
      throw new UnauthorizedException('账号已被停用', ERROR_CODES.AUTH_DISABLED);
    }

    this.lock.recordSuccess(input.username, input.ip);
    const tokens = this.sessions.issueFor(account);
    await this.touchLastLogin(account, input.ip);
    await this.loginLogs.record({
      userId: account.userId,
      username: account.username,
      loginType: 'login',
      success: true,
      failReason: null,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      user: { ...toUserInfo(account), accessToken: tokens.accessToken },
      tokens,
    };
  }

  /** 刷新：整段逻辑（含"失败必返 403"）在 AuthSessionService。 */
  refresh(
    rawRefreshToken: string | undefined,
    meta: ClientMeta,
  ): Promise<AuthTokens> {
    return this.sessions.refresh(rawRefreshToken, meta);
  }

  /**
   * 登出只记日志 + 由控制器清 Cookie：accessToken 是无状态的，剩余有效期靠前端丢弃。
   * 真正要"立刻踢人"的场景（禁用、改密）走 `token_version`，见权限模型设计 §5.4。
   */
  async logout(user: AuthUser, meta: ClientMeta): Promise<void> {
    await this.loginLogs.record({
      userId: user.userId,
      username: user.username,
      loginType: 'logout',
      success: true,
      failReason: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /** `/auth/codes`：超管给全集（后端接口设计 §2.4），其余走 30 秒缓存。 */
  codesOf(user: AuthUser): Promise<AuthCodes> {
    return this.permissionCodes.codeList(
      user.userId,
      user.roles.includes(SUPER_ADMIN_ROLE),
    );
  }

  private async recordFailedLogin(
    input: LoginInput,
    userId: string | null,
    reason: string,
  ): Promise<void> {
    this.lock.recordFailure(input.username, input.ip);
    await this.loginLogs.record({
      userId,
      username: input.username,
      loginType: 'login',
      success: false,
      failReason: reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  /** 哈希格式不合法（例如有人手工往库里塞了明文）也按"密码错"处理，不外泄细节。 */
  private async passwordMatches(
    account: Account,
    password: string,
  ): Promise<boolean> {
    const id = toUserId(account.userId);
    if (id === null) {
      return false;
    }
    const row = await this.db.sysUser.findUnique({
      where: { id },
      select: { passwordHash: true },
    });
    if (!row) {
      return false;
    }
    try {
      return await verifyArgon2(row.passwordHash, password);
    } catch {
      return false;
    }
  }

  private async touchLastLogin(account: Account, ip: string | null): Promise<void> {
    const id = toUserId(account.userId);
    if (id === null) {
      return;
    }
    try {
      await this.db.sysUser.update({
        where: { id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      });
    } catch (error: unknown) {
      // 登录统计写失败不该把用户挡在门外（比如 inet 列收到了脏值）。
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          userId: account.userId,
        },
        '更新最后登录时间失败',
      );
    }
  }
}

function toUserInfo(account: Account): Omit<LoginResult, 'accessToken'> {
  return {
    avatar: account.avatar,
    homePath: HOME_PATH,
    realName: account.realName,
    roles: account.roles.map((role) => role.code),
    userId: account.userId,
    username: account.username,
  };
}

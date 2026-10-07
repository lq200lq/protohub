import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { IS_PUBLIC_KEY } from '../decorator/public.decorator';
import type { HttpRequestLike } from '../http-types';
import {
  ForbiddenBusinessException,
  UnauthorizedException,
} from '../exception/business.exception';
import type { AccountService } from './account.service';
import type { Account } from './account.service';
import { AuthGuard } from './auth.guard';
import type { JwtTokenService } from './jwt-token.service';
import type { PermissionCodeService } from './permission-code.service';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';

function account(overrides: Partial<Account> = {}): Account {
  return {
    userId: '7',
    username: 'publisher01',
    realName: '发布者',
    avatar: null,
    email: null,
    phone: null,
    status: 1,
    tokenVersion: 3,
    forcePasswordChange: false,
    roles: [{ code: 'publisher', name: '发布者', dataScope: 'member' }],
    dataScope: 'member',
    superAdmin: false,
    ...overrides,
  };
}

interface FakeContext {
  readonly request: HttpRequestLike & { user?: unknown };
  readonly context: ExecutionContext;
}

function contextFor(url: string, headers: Record<string, unknown> = {}): FakeContext {
  const request = { headers, method: 'GET', url };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
  };
  return { request, context: context as unknown as ExecutionContext };
}

const handler = function probe(): void {};
const controller = class ProbeController {};

function toAuthUser(target: Account) {
  return {
    userId: target.userId,
    username: target.username,
    realName: target.realName,
    avatar: target.avatar,
    email: target.email,
    phone: target.phone,
    roles: target.roles.map((role) => role.code),
    primaryRoleName: target.roles[0]?.name ?? null,
    dataScope: target.dataScope,
    forcePasswordChange: target.forcePasswordChange,
    tokenVersion: target.tokenVersion,
  };
}

interface HarnessInput {
  readonly account?: Account | null;
  readonly codes?: Set<string>;
  readonly tokenState?: 'ok' | 'expired' | 'invalid';
  readonly signedTokenVersion?: number;
  readonly metadata?: ReadonlyMap<string, unknown>;
}

function buildGuard(input: HarnessInput = {}) {
  const current = input.account === undefined ? account() : input.account;
  const loadById = vi.fn(async (): Promise<Account | null> => current);
  const codesOfUser = vi.fn(async (): Promise<ReadonlySet<string>> =>
    input.codes ? input.codes : new Set<string>(),
  );
  const reflector = {
    getAllAndOverride: (key: string): unknown => input.metadata?.get(key),
  };
  const tokens = {
    readBearer: (value: string | undefined): string | undefined => value,
    verifyAccessToken: (): { sub: string; tv: number } => {
      if (input.tokenState === 'expired') {
        throw new UnauthorizedException('登录已过期', ERROR_CODES.AUTH_TOKEN_EXPIRED);
      }
      if (input.tokenState === 'invalid') {
        throw new UnauthorizedException(
          '登录状态已失效',
          ERROR_CODES.AUTH_TOKEN_INVALID,
        );
      }
      return { sub: current?.userId ?? '7', tv: input.signedTokenVersion ?? 3 };
    },
  };
  const accounts = { loadById, toAuthUser };

  const guard = new AuthGuard(
    reflector as unknown as Reflector,
    tokens as unknown as JwtTokenService,
    accounts as unknown as AccountService,
    { codesOfUser } as unknown as PermissionCodeService,
  );
  return { guard, loadById, codesOfUser };
}

const AUTH_HEADER = { authorization: 'signed-access-token' };

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((thrown: unknown) => thrown);
}

describe('AuthGuard（权限模型设计 §8.1）', () => {
  it('@Public 直接放行，一次查库都不做', async () => {
    const metadata = new Map<string, unknown>([[IS_PUBLIC_KEY, true]]);
    const { guard, loadById } = buildGuard({ metadata });
    const { context } = contextFor('/api/auth/login');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(loadById).not.toHaveBeenCalled();
  });

  it('M0 的 /api/health 探针按精确路径放行（它不在本次可改的控制器里）', async () => {
    const { guard } = buildGuard();
    // 带不带令牌都能过：这是给负载均衡用的匿名探针。
    await expect(guard.canActivate(contextFor('/api/health').context)).resolves.toBe(
      true,
    );
    await expect(
      guard.canActivate(contextFor('/api/health', AUTH_HEADER).context),
    ).resolves.toBe(true);
    // 前缀不算放行：/api/health/detail 将来要 system:log:list，没令牌照样 401。
    const error = await failureOf(
      guard.canActivate(contextFor('/api/health/detail').context),
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
  });

  it('缺 Authorization → 401 AUTH_UNAUTHORIZED', async () => {
    const { guard } = buildGuard();
    const error = await failureOf(guard.canActivate(contextFor('/api/user/info').context));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_UNAUTHORIZED,
    );
    expect((error as UnauthorizedException).httpStatus).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('令牌过期 → 401 + AUTH_TOKEN_EXPIRED（前端据此自动刷新，绝不能是 403）', async () => {
    const { guard } = buildGuard({ tokenState: 'expired' });
    const error = await failureOf(
      guard.canActivate(contextFor('/api/user/info', AUTH_HEADER).context),
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_TOKEN_EXPIRED,
    );
  });

  it('用户不存在 → 401；被禁用 → 401 AUTH_DISABLED', async () => {
    const missing = buildGuard({ account: null });
    const missingError = await failureOf(
      missing.guard.canActivate(contextFor('/api/user/info', AUTH_HEADER).context),
    );
    expect(missingError).toBeInstanceOf(UnauthorizedException);
    expect((missingError as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_TOKEN_INVALID,
    );

    const disabled = buildGuard({ account: account({ status: 0 }) });
    const disabledError = await failureOf(
      disabled.guard.canActivate(contextFor('/api/user/info', AUTH_HEADER).context),
    );
    expect((disabledError as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_DISABLED,
    );
  });

  it('token_version 对不上（改密/被重置后）→ 401 立刻失效', async () => {
    const { guard } = buildGuard({
      account: account({ tokenVersion: 9 }),
      signedTokenVersion: 3,
    });
    const error = await failureOf(
      guard.canActivate(contextFor('/api/user/info', AUTH_HEADER).context),
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    // 撤销走的是 401（不是 403）：前端拿到 401 才会刷新/回登录页。
    expect((error as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_TOKEN_INVALID,
    );
    expect((error as UnauthorizedException).message).toContain('请重新登录');
  });

  it('@RequirePermission 满足任一即通过（OR）', async () => {
    const metadata = new Map<string, unknown>([
      [REQUIRE_PERMISSION_KEY, ['proto:prototype:publish', 'proto:prototype:rollback']],
    ]);
    const { guard, codesOfUser } = buildGuard({
      codes: new Set(['proto:prototype:rollback']),
      metadata,
    });
    await expect(
      guard.canActivate(contextFor('/api/releases', AUTH_HEADER).context),
    ).resolves.toBe(true);
    expect(codesOfUser).toHaveBeenCalledWith('7');
  });

  it('一个都不命中 → 403 AUTH_FORBIDDEN（已登录但权限不足，不触发刷新）', async () => {
    const metadata = new Map<string, unknown>([
      [REQUIRE_PERMISSION_KEY, ['system:user:delete']],
    ]);
    const { guard } = buildGuard({
      codes: new Set(['proto:release:list']),
      metadata,
    });
    const error = await failureOf(
      guard.canActivate(contextFor('/api/system/users/3', AUTH_HEADER).context),
    );
    expect(error).toBeInstanceOf(ForbiddenBusinessException);
    expect((error as ForbiddenBusinessException).errorCode).toBe(
      ERROR_CODES.AUTH_FORBIDDEN,
    );
    expect((error as ForbiddenBusinessException).httpStatus).toBe(HttpStatus.FORBIDDEN);
  });

  it('super_admin 短路（C-5）：不查权限码表也放行', async () => {
    const metadata = new Map<string, unknown>([
      [REQUIRE_PERMISSION_KEY, ['system:menu:delete']],
    ]);
    const { guard, codesOfUser } = buildGuard({
      account: account({ superAdmin: true }),
      metadata,
    });
    await expect(
      guard.canActivate(contextFor('/api/system/menus/9', AUTH_HEADER).context),
    ).resolves.toBe(true);
    expect(codesOfUser).not.toHaveBeenCalled();
  });

  it('未标注权限码 = 仅需登录，并把登录态挂到 request.user', async () => {
    const { guard } = buildGuard();
    const probe = contextFor('/api/user/info', AUTH_HEADER);
    await expect(guard.canActivate(probe.context)).resolves.toBe(true);
    expect(probe.request.user).toMatchObject({
      userId: '7',
      username: 'publisher01',
      roles: ['publisher'],
    });
  });
});

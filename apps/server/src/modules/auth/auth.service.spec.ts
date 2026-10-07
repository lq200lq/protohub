import { HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import { ERROR_CODES } from '@protohub/shared';
import { hash as hashArgon2 } from 'argon2';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Account, AccountService } from '../../common/permission/account.service';
import type { AuthUser } from '../../common/permission/auth-user';
import {
  BusinessException,
  UnauthorizedException,
} from '../../common/exception/business.exception';
import type { PermissionCodeService } from '../../common/permission/permission-code.service';
import type { AuthSessionService, AuthTokens } from './auth-session.service';
import { AuthService, type LoginInput } from './auth.service';
import type { LoginLogService } from './login-log.service';
import type { LoginLockService } from './login-lock.service';

const PASSWORD = 'Proper#Pass1';

function account(overrides: Partial<Account> = {}): Account {
  return {
    userId: '7',
    username: 'publisher01',
    realName: '发布者',
    avatar: null,
    email: null,
    phone: null,
    status: 1,
    tokenVersion: 2,
    forcePasswordChange: false,
    roles: [{ code: 'publisher', name: '发布者', dataScope: 'member' }],
    dataScope: 'member',
    superAdmin: false,
    ...overrides,
  };
}

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: '7',
    username: 'publisher01',
    realName: '发布者',
    avatar: null,
    email: null,
    phone: null,
    roles: ['publisher'],
    primaryRoleName: '发布者',
    dataScope: 'member',
    forcePasswordChange: false,
    tokenVersion: 2,
    ...overrides,
  };
}

const TOKENS: AuthTokens = {
  accessToken: 'access.jwt.value',
  refreshToken: 'refresh.jwt.value',
  sessionToken: 'v1.7.2.9.sig',
};

interface HarnessInput {
  readonly foundAccount?: Account | null;
  readonly passwordHash?: string | null;
  readonly lockedError?: Error;
  readonly updateError?: Error;
}

interface Harness {
  readonly service: AuthService;
  readonly loadByUsername: ReturnType<typeof vi.fn>;
  readonly issueFor: ReturnType<typeof vi.fn>;
  readonly assertNotLocked: ReturnType<typeof vi.fn>;
  readonly recordFailure: ReturnType<typeof vi.fn>;
  readonly recordSuccess: ReturnType<typeof vi.fn>;
  readonly logRecord: ReturnType<typeof vi.fn>;
  readonly codeList: ReturnType<typeof vi.fn>;
  readonly update: ReturnType<typeof vi.fn>;
}

function harness(input: HarnessInput = {}): Harness {
  const foundAccount = input.foundAccount === undefined ? account() : input.foundAccount;
  const loadByUsername = vi.fn(async () => foundAccount);
  const issueFor = vi.fn(() => TOKENS);
  const assertNotLocked = input.lockedError
    ? vi.fn(async () => {
        throw input.lockedError;
      })
    : vi.fn(async () => undefined);
  const recordFailure = vi.fn();
  const recordSuccess = vi.fn();
  const logRecord = vi.fn(async () => undefined);
  const codeList = vi.fn(async () => ['proto:release:list']);
  const findUnique = vi.fn(async () =>
    input.passwordHash === null ? null : { passwordHash: input.passwordHash },
  );
  const update = input.updateError
    ? vi.fn(async () => {
        throw input.updateError;
      })
    : vi.fn(async () => ({}));
  const db = { sysUser: { findUnique, update } } as unknown as PrismaClient;

  const service = new AuthService(
    { loadByUsername } as unknown as AccountService,
    { issueFor, refresh: vi.fn(async () => TOKENS) } as unknown as AuthSessionService,
    { assertNotLocked, recordFailure, recordSuccess } as unknown as LoginLockService,
    { record: logRecord } as unknown as LoginLogService,
    { codeList } as unknown as PermissionCodeService,
    db,
  );
  return {
    service,
    loadByUsername,
    issueFor,
    assertNotLocked,
    recordFailure,
    recordSuccess,
    logRecord,
    codeList,
    update,
  };
}

function input(overrides: Partial<LoginInput> = {}): LoginInput {
  return { username: 'publisher01', password: PASSWORD, ip: '10.0.0.1', userAgent: 'vitest', ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) {
    throw new Error('预期抛出业务异常');
  }
  return error;
}

describe('AuthService.login（后端接口设计 §2.1）', () => {
  let goodHash: string;

  beforeAll(async () => {
    // 降低 argon2 参数：单测要的是"真的走一遍校验"，不是抗 GPU 强度。
    goodHash = await hashArgon2(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
  });

  it('成功：返回 vben 要的 LoginResult + 三个令牌，记成功日志、清失败计数、更新最后登录', async () => {
    const h = harness({ passwordHash: goodHash });
    const outcome = await h.service.login(input());
    expect(outcome.user).toEqual({
      accessToken: 'access.jwt.value',
      avatar: null,
      homePath: '/dashboard/workspace',
      realName: '发布者',
      roles: ['publisher'],
      userId: '7',
      username: 'publisher01',
    });
    expect(outcome.tokens).toBe(TOKENS);
    expect(h.recordSuccess).toHaveBeenCalledWith('publisher01', '10.0.0.1');
    expect(h.logRecord).toHaveBeenCalledWith({
      userId: '7',
      username: 'publisher01',
      loginType: 'login',
      success: true,
      failReason: null,
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    expect(h.update).toHaveBeenCalledWith({
      where: { id: BigInt(7) },
      data: { lastLoginAt: expect.any(Date), lastLoginIp: '10.0.0.1' },
    });
  });

  it('先判锁定：被锁时连用户名都不查（429 优先于凭据校验）', async () => {
    const h = harness({
      lockedError: new BusinessException(
        '失败次数过多，请 15 分钟后再试',
        ERROR_CODES.RATE_LIMITED,
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    });
    const error = await failure(h.service.login(input()));
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(h.loadByUsername).not.toHaveBeenCalled();
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it('用户名不存在与密码错误对外同码同文（防枚举），只有日志里的原因不同', async () => {
    const missing = harness({ foundAccount: null, passwordHash: goodHash });
    const missingError = await failure(missing.service.login(input({ username: 'ghost' })));
    expect(missingError).toBeInstanceOf(UnauthorizedException);
    expect((missingError as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_BAD_CREDENTIALS,
    );

    const wrongPassword = harness({ passwordHash: '$argon2id$not-the-same-hash' });
    const wrongError = await failure(wrongPassword.service.login(input()));
    expect((wrongError as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_BAD_CREDENTIALS,
    );
    expect(wrongError.message).toBe(missingError.message);

    expect(missing.logRecord.mock.calls[0]?.[0]).toMatchObject({
      userId: null,
      success: false,
      failReason: 'user_not_found',
    });
    expect(wrongPassword.logRecord.mock.calls[0]?.[0]).toMatchObject({
      userId: '7',
      success: false,
      failReason: 'bad_password',
    });
    // 两种失败都要计入锁定窗口。
    expect(missing.recordFailure).toHaveBeenCalledWith('ghost', '10.0.0.1');
    expect(wrongPassword.recordFailure).toHaveBeenCalledWith('publisher01', '10.0.0.1');
    expect(missing.issueFor).not.toHaveBeenCalled();
    expect(wrongPassword.issueFor).not.toHaveBeenCalled();
  });

  it('停用账号要在密码正确之后才报 AUTH_DISABLED（否则等于白送一个枚举口子）', async () => {
    const h = harness({
      foundAccount: account({ status: 0 }),
      passwordHash: goodHash,
    });
    const error = await failure(h.service.login(input()));
    expect((error as UnauthorizedException).errorCode).toBe(ERROR_CODES.AUTH_DISABLED);
    expect(h.logRecord.mock.calls[0]?.[0]).toMatchObject({ failReason: 'user_disabled' });
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it('库里是明文/坏哈希时按密码错误处理，不把 argon2 的异常透出去（500）', async () => {
    const h = harness({ passwordHash: 'plaintext-typo' });
    const error = await failure(h.service.login(input()));
    expect((error as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_BAD_CREDENTIALS,
    );
  });

  it('查不到密码行（并发删号）也按密码错误处理', async () => {
    const h = harness({ passwordHash: null });
    const error = await failure(h.service.login(input()));
    expect((error as UnauthorizedException).errorCode).toBe(
      ERROR_CODES.AUTH_BAD_CREDENTIALS,
    );
    expect(h.issueFor).not.toHaveBeenCalled();
  });

  it('最后登录时间写失败不阻断登录（统计而已，别把用户挡在门外）', async () => {
    const h = harness({
      passwordHash: goodHash,
      updateError: new Error('invalid input for inet'),
    });
    await expect(h.service.login(input({ ip: null }))).resolves.toMatchObject({
      user: { accessToken: 'access.jwt.value' },
    });
  });

  it('refresh 转发给 AuthSessionService（失败必返 403 的语义集中在一处）', async () => {
    const h = harness({ passwordHash: goodHash });
    const refresh = vi.spyOn(h.service as AuthService, 'refresh');
    const result = await h.service.refresh('raw', { ip: '10.0.0.1', userAgent: 'vitest' });
    expect(result).toBe(TOKENS);
    expect(refresh).toHaveBeenCalled();
  });

  it('logout 只记日志（不改 token_version，不吊销 refreshToken）', async () => {
    const h = harness({ passwordHash: goodHash });
    await h.service.logout(authUser(), { ip: '10.0.0.2', userAgent: 'vitest' });
    expect(h.logRecord).toHaveBeenCalledWith({
      userId: '7',
      username: 'publisher01',
      loginType: 'logout',
      success: true,
      failReason: null,
      ip: '10.0.0.2',
      userAgent: 'vitest',
    });
  });

  it('codesOf：是否超管按角色判定后交给缓存层（C-5）', async () => {
    const h = harness({ passwordHash: goodHash });
    await expect(h.service.codesOf(authUser({ roles: ['super_admin', 'admin'] }))).resolves
      .toEqual(['proto:release:list']);
    expect(h.codeList).toHaveBeenCalledWith('7', true);
    h.codeList.mockClear();
    await h.service.codesOf(authUser({ roles: ['publisher'] }));
    expect(h.codeList).toHaveBeenCalledWith('7', false);
  });
});

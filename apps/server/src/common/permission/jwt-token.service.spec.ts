import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';
import { JwtService } from '@nestjs/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_SECRETS } from '../../testing/env.fixture';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import { BusinessException } from '../exception/business.exception';
import { JwtTokenService } from './jwt-token.service';

function service(overrides: Record<string, unknown> = {}): JwtTokenService {
  return new JwtTokenService(fakeAppEnv({ NODE_ENV: 'test', ...overrides }));
}

async function failure(promise: Promise<unknown>): Promise<BusinessException> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof BusinessException)) {
    throw new Error('预期抛出 BusinessException');
  }
  return error;
}

describe('JwtTokenService（权限模型设计 §5.1：access/refresh 各用一个密钥）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTL 来自环境变量：JWT 过期时间和 Cookie Max-Age 必须同源', () => {
    const tokens = service();
    expect(tokens.accessTokenTtlSeconds).toBe(7_200); // ACCESS_TOKEN_TTL 默认 2h
    expect(tokens.refreshTokenTtlSeconds).toBe(604_800); // REFRESH_TOKEN_TTL 默认 7d
    expect(service({ ACCESS_TOKEN_TTL: '45m' }).accessTokenTtlSeconds).toBe(2_700);
  });

  it('accessToken 载荷带 sub/username/tv/jti/iat/exp（tv 是改密撤销的依据）', () => {
    const tokens = service();
    const payload = tokens.verifyAccessToken(
      tokens.signAccessToken({ userId: '42', username: 'admin', tokenVersion: 3 }),
    );
    expect(payload.sub).toBe('42');
    expect(payload.username).toBe('admin');
    expect(payload.tv).toBe(3);
    expect(payload.jti).toHaveLength(36);
    expect(payload.exp - payload.iat).toBe(7_200);
  });

  it('refreshToken 不能当 accessToken 用（两个密钥不同，防跨用途重放）', async () => {
    const tokens = service();
    const refresh = tokens.signRefreshToken({ userId: '42', tokenVersion: 0 });
    const error = await failure(
      Promise.resolve().then(() => tokens.verifyAccessToken(refresh)),
    );
    expect(error.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
    expect(error.errorCode).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
    // 反向亦然。
    const access = tokens.signAccessToken({
      userId: '42',
      username: 'admin',
      tokenVersion: 0,
    });
    expect(
      (await failure(Promise.resolve().then(() => tokens.verifyRefreshToken(access))))
        .errorCode,
    ).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it('签名被改一个字符 → 401 AUTH_TOKEN_INVALID（不是 500）', async () => {
    const tokens = service();
    const raw = tokens.signAccessToken({
      userId: '42',
      username: 'admin',
      tokenVersion: 1,
    });
    const tampered = `${raw.slice(0, -2)}xx`;
    expect(
      (await failure(Promise.resolve().then(() => tokens.verifyAccessToken(tampered))))
        .errorCode,
    ).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it('过期 → 401 + AUTH_TOKEN_EXPIRED：前端只对这个码走"刷新后重放"', async () => {
    const tokens = service({ ACCESS_TOKEN_TTL: '2h' });
    const raw = tokens.signAccessToken({
      userId: '42',
      username: 'admin',
      tokenVersion: 1,
    });
    vi.setSystemTime(1_700_000_000_000 + (7_200 + 1) * 1_000);
    const error = await failure(Promise.resolve().then(() => tokens.verifyAccessToken(raw)));
    expect(error.errorCode).toBe(ERROR_CODES.AUTH_TOKEN_EXPIRED);
    expect(error.httpStatus).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('别的系统用同一算法签出的令牌一律拒（载荷字段不齐就不认）', async () => {
    const foreign = new JwtService({}).sign(
      { sub: '42' },
      { secret: TEST_SECRETS.JWT_ACCESS_SECRET, algorithm: 'HS256' },
    );
    const error = await failure(
      Promise.resolve().then(() => service().verifyAccessToken(foreign)),
    );
    expect(error.errorCode).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it('verifyAccessToken 缺 username 时补空串，其余字段仍按载荷返回', () => {
    const raw = new JwtService({}).sign(
      { sub: '42', tv: 5, jti: 'j-1', iat: 1, exp: 4_102_444_800 },
      { secret: TEST_SECRETS.JWT_ACCESS_SECRET, algorithm: 'HS256' },
    );
    expect(service().verifyAccessToken(raw)).toEqual({
      sub: '42',
      tv: 5,
      jti: 'j-1',
      iat: 1,
      exp: 4_102_444_800,
      username: '',
    });
  });

  it('readBearer 只认 `Bearer <token>`：格式不对按未登录处理，不做模糊匹配', () => {
    const tokens = service();
    expect(tokens.readBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(tokens.readBearer('  BeARER abc  ')).toBe('abc');
    expect(tokens.readBearer(['Bearer arr', 'Bearer other'])).toBe('arr');
    expect(tokens.readBearer(undefined)).toBeUndefined();
    expect(tokens.readBearer('')).toBeUndefined();
    expect(tokens.readBearer('Bearer')).toBeUndefined();
    expect(tokens.readBearer('Bearer ')).toBeUndefined();
    expect(tokens.readBearer('abc')).toBeUndefined();
    expect(tokens.readBearer('Basic abc')).toBeUndefined();
    expect(tokens.readBearer('Bearer a b')).toBeUndefined();
  });
});

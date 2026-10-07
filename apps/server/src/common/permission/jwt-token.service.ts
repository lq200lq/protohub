import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';
import { JwtService } from '@nestjs/jwt';

import { AppEnvService } from '../../config/app-env.service';
import { BusinessException } from '../exception/business.exception';
import { parseDurationSeconds } from './duration';

/** accessToken 载荷，字段名与权限模型设计 §5.1 一致（`tv` = token_version）。 */
export interface AccessTokenPayload {
  readonly sub: string;
  readonly username: string;
  readonly tv: number;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * refreshToken 载荷。
 * 文档只规定了 accessToken 的字段，这里额外带上 `tv`：改密/被禁用后，即便刷新令牌还留在
 * 浏览器里也不该换出新会话（权限模型设计 §5.4 的撤销语义对两种凭据都成立）。
 */
export interface RefreshTokenPayload {
  readonly sub: string;
  readonly tv: number;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new BusinessException(
      '登录状态已失效，请重新登录',
      ERROR_CODES.AUTH_TOKEN_INVALID,
      HttpStatus.UNAUTHORIZED,
    );
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BusinessException(
      '登录状态已失效，请重新登录',
      ERROR_CODES.AUTH_TOKEN_INVALID,
      HttpStatus.UNAUTHORIZED,
    );
  }
  return value;
}

/**
 * access / refresh 两个令牌的服务：同一种 HS256，但**各用自己的密钥**
 * （配置里四个密钥必须两两不同，见 env.ts 的校验），这样 refresh 令牌无法被当成
 * accessToken 直接调业务接口。
 */
@Injectable()
export class JwtTokenService {
  private readonly jwt = new JwtService({});

  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;

  constructor(env: AppEnvService) {
    const config = env.env;
    this.accessSecret = config.secrets.jwtAccess;
    this.refreshSecret = config.secrets.jwtRefresh;
    this.accessTokenTtlSeconds = parseDurationSeconds(config.jwt.accessTokenTtl);
    this.refreshTokenTtlSeconds = parseDurationSeconds(
      config.jwt.refreshTokenTtl,
    );
  }

  signAccessToken(input: {
    userId: string;
    username: string;
    tokenVersion: number;
  }): string {
    return this.jwt.sign(
      {
        sub: input.userId,
        username: input.username,
        tv: input.tokenVersion,
        jti: randomUUID(),
      },
      {
        secret: this.accessSecret,
        algorithm: 'HS256',
        expiresIn: this.accessTokenTtlSeconds,
      },
    );
  }

  signRefreshToken(input: { userId: string; tokenVersion: number }): string {
    return this.jwt.sign(
      { sub: input.userId, tv: input.tokenVersion, jti: randomUUID() },
      {
        secret: this.refreshSecret,
        algorithm: 'HS256',
        expiresIn: this.refreshTokenTtlSeconds,
      },
    );
  }

  /** 校验失败一律 401（权限模型设计 §5.2：401 = 未登录/令牌无效，前端据此触发刷新）。 */
  verifyAccessToken(raw: string): AccessTokenPayload {
    const base = this.verifyBase(raw, this.accessSecret);
    return { ...base, username: base.username ?? '' };
  }

  /**
   * refreshToken 的失败语义与 accessToken 不同：/auth/refresh 失败要返 403 + 错误包装
   * （后端接口设计 §2.2），所以这里不自己决定状态码，只把异常抛给调用方。
   */
  verifyRefreshToken(raw: string): RefreshTokenPayload {
    return this.verifyBase(raw, this.refreshSecret);
  }

  /**
   * 从 `Authorization: Bearer x` 取 token；格式不对按"未登录"处理。
   * 参数允许数组是防御性的：某些代理/测试会把同名头收成 `string[]`。
   */
  readBearer(headerValue: string | readonly string[] | undefined): string | undefined {
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (typeof raw !== 'string') {
      return undefined;
    }
    const [scheme, token, rest] = raw.trim().split(/\s+/);
    if (!scheme || !token || rest || scheme.toLowerCase() !== 'bearer') {
      return undefined;
    }
    return token;
  }

  private verifyBase(
    raw: string,
    secret: string,
  ): RefreshTokenPayload & { username?: string } {
    let decoded: unknown;
    try {
      decoded = this.jwt.verify(raw, { secret });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      const expired = name === 'TokenExpiredError';
      throw new BusinessException(
        expired ? '登录已过期，请重新登录' : '登录状态已失效，请重新登录',
        expired
          ? ERROR_CODES.AUTH_TOKEN_EXPIRED
          : ERROR_CODES.AUTH_TOKEN_INVALID,
        HttpStatus.UNAUTHORIZED,
      );
    }
    const payload = asRecord(decoded);
    // 只认我们自己的载荷形状：别的系统签出的同算法 JWT 在这里就该被拒。
    return {
      sub: requireString(payload, 'sub'),
      tv: requireNumber(payload, 'tv'),
      jti: requireString(payload, 'jti'),
      iat: requireNumber(payload, 'iat'),
      exp: requireNumber(payload, 'exp'),
      username:
        typeof payload['username'] === 'string' ? payload['username'] : undefined,
    };
  }
}

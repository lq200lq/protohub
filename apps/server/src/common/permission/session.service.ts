import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppEnvService } from '../../config/app-env.service';
import { parseDurationSeconds } from './duration';

/** 会话 Cookie 的载荷格式（权限模型设计 §5.1）：`v1.{userId}.{tokenVersion}.{exp}.{sig}`。 */
const SESSION_PREFIX = 'v1';

export interface SessionClaims {
  readonly userId: string;
  readonly tokenVersion: number;
  /** 秒级时间戳。 */
  readonly expiresAt: number;
}

function isUnsignedInteger(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * `proto_sess` 的签发与验签。
 *
 * 它不是 JWT：这个 Cookie 只用于原型访问决策（顶层导航不会带 Authorization 头），
 * 载荷里三个字段加一个 HMAC 就够了，也不需要跨语言互操作。
 * 之所以要把 `tokenVersion` 编进去：改密/被禁用后旧 Cookie 必须立刻失效（§5.4），
 * 拿到 `userId` 后再比库里的 `token_version` 就能做到。
 */
@Injectable()
export class SessionService {
  private readonly secret: string;

  /** 与 refreshToken 同期（文档表格里两者都是 7 天），没有独立的配置项。 */
  readonly ttlSeconds: number;

  constructor(env: AppEnvService) {
    this.secret = env.env.secrets.sessionCookie;
    this.ttlSeconds = parseDurationSeconds(env.env.jwt.refreshTokenTtl);
  }

  issue(userId: string, tokenVersion: number, nowMs = Date.now()): string {
    const expiresAt = Math.floor(nowMs / 1000) + this.ttlSeconds;
    const unsigned = `${SESSION_PREFIX}.${userId}.${tokenVersion}.${expiresAt}`;
    return `${unsigned}.${this.sign(unsigned)}`;
  }

  /** 验签失败/过期一律返回 null：调用方据此判定"未登录"，不区分原因，避免探测。 */
  verify(
    raw: string | undefined,
    nowMs = Date.now(),
  ): SessionClaims | null {
    if (!raw) {
      return null;
    }
    const parts = raw.split('.');
    const [prefix, userId, tokenVersion, expiresAt, signature] = parts;
    if (
      parts.length !== 5 ||
      prefix !== SESSION_PREFIX ||
      typeof userId !== 'string' ||
      typeof tokenVersion !== 'string' ||
      typeof expiresAt !== 'string' ||
      typeof signature !== 'string' ||
      !isUnsignedInteger(userId) ||
      !isUnsignedInteger(tokenVersion) ||
      !isUnsignedInteger(expiresAt)
    ) {
      return null;
    }
    const unsigned = `${SESSION_PREFIX}.${userId}.${tokenVersion}.${expiresAt}`;
    if (!this.signMatches(unsigned, signature)) {
      return null;
    }
    const expiresAtSeconds = Number(expiresAt);
    if (expiresAtSeconds * 1000 <= nowMs) {
      return null;
    }
    return {
      userId,
      tokenVersion: Number(tokenVersion),
      expiresAt: expiresAtSeconds,
    };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  private signMatches(payload: string, signature: string): boolean {
    const expected = this.sign(payload);
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);
    return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }
}

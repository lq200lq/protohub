import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppEnvService } from '../../config/app-env.service';
import { parseDurationSeconds } from '../../common/permission/duration';

/** 解锁令牌的载荷格式（机制 §5.2）：`v1.{policyVersion}.{exp}.{sig}`。 */
const UNLOCK_PREFIX = 'v1';

export interface UnlockTokenTarget {
  /** 原型的 `policy_version`：改密码/改访问模式时 +1（D-07）。 */
  readonly policyVersion: number;
  readonly projectCode: string;
  readonly prototypeCode: string;
}

/**
 * 参与签名的原文：两级编码 + policy_version + 过期时间（机制 §5.2 逐字对齐）。
 *
 * 为什么编码要进签名：Cookie 名只有原型数字 ID（`proto_access_p31`），若签名只算
 * `policy_version|exp`，把 A 原型的 Cookie 值挪到 B 原型的请求上只需要复制一个字符串。
 * 编码进了签名，挪动即失效。
 */
function signingPayload(target: UnlockTokenTarget, expiresAt: number): string {
  return `${target.projectCode}|${target.prototypeCode}|${target.policyVersion}|${expiresAt}`;
}

/**
 * 密码档解锁令牌（迭代实施计划 M4-T8）。
 *
 * 为什么用 `policy_version` 而不是"已签发令牌表"：改密码要能**立即**踢掉所有人，而
 * `policy_version` 参与签名 → 一变旧令牌签名校验必然失败，既不用建表也不用等过期。
 * 它在原型行上，所以改 A 的密码不影响同项目下 B 的解锁状态（这条是 D-07 的收益）。
 */
@Injectable()
export class UnlockTokenService {
  private readonly secret: string;

  /** Cookie 的 `Max-Age` 用这个值，必须与令牌里的 exp 同源，否则会出现"Cookie 还在但令牌已过期"。 */
  readonly ttlSeconds: number;

  constructor(env: AppEnvService) {
    this.secret = env.env.secrets.accessToken;
    this.ttlSeconds = parseDurationSeconds(env.env.jwt.unlockTokenTtl);
  }

  issue(target: UnlockTokenTarget, nowMs = Date.now()): string {
    const expiresAt = Math.floor(nowMs / 1000) + this.ttlSeconds;
    return `${UNLOCK_PREFIX}.${target.policyVersion}.${expiresAt}.${this.sign(target, expiresAt)}`;
  }

  /**
   * 验签：任何一步不过都返回 false，不区分原因。
   * 区分开来会给探测者"格式对但编码错"这类可利用的差异，而调用方拿到的处置都一样（要重新输密码）。
   */
  verify(
    raw: string | undefined,
    target: UnlockTokenTarget,
    nowMs = Date.now(),
  ): boolean {
    if (!raw) {
      return false;
    }
    const parts = raw.split('.');
    const [prefix, policyVersion, expiresAt, signature] = parts;
    if (
      parts.length !== 4 ||
      prefix !== UNLOCK_PREFIX ||
      typeof policyVersion !== 'string' ||
      typeof expiresAt !== 'string' ||
      typeof signature !== 'string' ||
      !/^\d+$/.test(policyVersion) ||
      !/^\d+$/.test(expiresAt)
    ) {
      return false;
    }
    // 段 2 必须等于**该原型当前的** policy_version：先比这个再算签名，既省一次 HMAC，
    // 也让"改密码后立刻失效"这条承诺不依赖签名的强度。
    if (Number(policyVersion) !== target.policyVersion) {
      return false;
    }
    const expiresAtSeconds = Number(expiresAt);
    if (expiresAtSeconds * 1000 <= nowMs) {
      return false;
    }
    const expected = Buffer.from(this.sign(target, expiresAtSeconds));
    const actual = Buffer.from(signature);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private sign(target: UnlockTokenTarget, expiresAt: number): string {
    return createHmac('sha256', this.secret)
      .update(signingPayload(target, expiresAt))
      .digest('base64url');
  }
}

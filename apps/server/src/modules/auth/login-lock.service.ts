import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';

import { rateLimitedError } from '../../common/rate-limit';
import { PRISMA_CLIENT } from '../../common/permission/prisma-client';
import { LOGIN_FAIL_THRESHOLD, LOGIN_LOCK_SECONDS } from './auth.constants';

const LOCK_WINDOW_MS = LOGIN_LOCK_SECONDS * 1_000;
const MAX_TRACKED_KEYS = 1_000;

export function attemptKey(username: string, ip: string | null): string {
  return `${username.toLowerCase()}|${ip ?? 'no-ip'}`;
}

/**
 * 登录失败锁定（后端接口设计 §2.1：连续失败 5 次锁 15 分钟，按 `username + ip` 计数，"内存 + 落库"）。
 *
 * 两层：
 * - 内存计数/锁：命中就是 O(1)，不给每次登录加查询；
 * - `sys_login_log` 回补：进程重启或多个实例各自计时时，库里的失败轨迹仍然能把该锁上的
 *   账号锁上（否则重启一次就等于给爆破者清了计数）。
 */
@Injectable()
export class LoginLockService {
  private readonly logger = new Logger(LoginLockService.name);
  /** key -> 锁定到期时间（毫秒时间戳）。 */
  private readonly lockedUntil = new Map<string, number>();
  /** key -> 本窗口内的失败次数。 */
  private readonly failures = new Map<string, number>();

  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  async assertNotLocked(
    username: string,
    ip: string | null,
    now: number = Date.now(),
  ): Promise<void> {
    const key = attemptKey(username, ip);
    const cached = this.lockedUntil.get(key);
    if (cached !== undefined) {
      if (cached > now) {
        throw rateLimitedError(cached, now);
      }
      this.lockedUntil.delete(key);
    }
    const recentFailures = await this.countRecentFailures(username, ip, now);
    if (recentFailures >= LOGIN_FAIL_THRESHOLD) {
      const until = now + LOCK_WINDOW_MS;
      this.lockedUntil.set(key, until);
      this.failures.delete(key);
      throw rateLimitedError(until, now);
    }
  }

  recordFailure(username: string, ip: string | null): void {
    const key = attemptKey(username, ip);
    const next = (this.failures.get(key) ?? 0) + 1;
    if (next >= LOGIN_FAIL_THRESHOLD) {
      this.lockedUntil.set(key, Date.now() + LOCK_WINDOW_MS);
      this.failures.delete(key);
    } else {
      this.failures.set(key, next);
    }
    this.prune();
  }

  recordSuccess(username: string, ip: string | null): void {
    const key = attemptKey(username, ip);
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }

  /** 供测试与排障观察，不参与判定。 */
  isLocked(username: string, ip: string | null, now = Date.now()): boolean {
    const until = this.lockedUntil.get(attemptKey(username, ip));
    return until !== undefined && until > now;
  }

  reset(): void {
    this.failures.clear();
    this.lockedUntil.clear();
  }

  private async countRecentFailures(
    username: string,
    ip: string | null,
    now: number,
  ): Promise<number> {
    try {
      return await this.db.sysLoginLog.count({
        where: {
          loginType: 'login',
          success: false,
          username: { equals: username, mode: 'insensitive' },
          createdAt: { gte: new Date(now - LOCK_WINDOW_MS) },
          ...(ip === null ? {} : { ip }),
        },
      });
    } catch (error: unknown) {
      // 回补查询失败不该阻断登录：内存计数仍然生效。
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        '登录失败计数回补查询失败',
      );
      return 0;
    }
  }

  private prune(): void {
    if (this.failures.size <= MAX_TRACKED_KEYS) {
      return;
    }
    this.failures.clear();
    this.lockedUntil.clear();
  }
}

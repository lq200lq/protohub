import { Injectable } from '@nestjs/common';

import { rateLimitedError } from '../../common/rate-limit';
import {
  ACCESS_UNLOCK_FAIL_THRESHOLD,
  ACCESS_UNLOCK_LOCK_SECONDS,
  ACCESS_UNLOCK_MAX_TRACKED_KEYS,
} from '../../config/constants';

/**
 * 解锁失败锁定（[后端接口设计.md](../../../../../docs/后端接口设计.md) §9.2：同 IP 连续失败
 * 5 次锁 10 分钟；迭代实施计划 M4-T7）。
 *
 * 为什么不复用 `LoginLockService`：它的计数键是"账号 + IP"，还要拿 `sys_login_log` 回补重启前的
 * 失败轨迹——而这里没有账号可填（访问者是匿名的），也没有哪张表按"某人输错了某原型的密码"记日志。
 * 硬套的话要么往登录日志里塞伪记录（污染 M1 的登录审计），要么每次判定都跑一条恒 0 的 count。
 * 共用的是同一句人话与同一个 429 语义（`common/rate-limit.ts`），各自是各自的窗口与键。
 *
 * 只放内存、不落库的后果是"进程重启即清零"，可接受的两条理由：
 * 1. 部署方案 §5 在 nginx 侧还有第二道 `limit_req zone=proto_unlock rate=10r/m`，重启后想接着
 *    喷仍要先过那道；
 * 2. 这条锁的目的从来不是"永不放过爆破者"，而是让**单次**在线爆破在几分钟内拿不到第 6 次机会，
 *    把 argon2 的吞吐压到人肉级别。
 *
 * 内存本身也要封顶：`failures` 无上限就是拿请求体打堆（每个不同的 IP×原型键 约 100 字节），
 * 所以超阈值整体清空——被清掉的那几个 IP 少计几次失败，比整个服务 OOM 便宜。
 */

/** 锁的粒度：`{来源 IP} | {项目编码}/{原型编码}`（见 `unlock.service.ts` 里为什么不带原型 ID）。 */
export function unlockAttemptKey(input: {
  ip: string | null;
  projectCode: string;
  prototypeCode: string;
}): string {
  const origin = input.ip ?? 'no-ip';
  return `${origin}|${input.projectCode}/${input.prototypeCode}`;
}

const LOCK_WINDOW_MS = ACCESS_UNLOCK_LOCK_SECONDS * 1000;

@Injectable()
export class UnlockRateLimiter {
  /** key -> 锁定到期时间（毫秒）。 */
  private readonly lockedUntil = new Map<string, number>();
  /** key -> 本窗口内的连续失败次数（成功即清零，与"连续"二字对齐）。 */
  private readonly failures = new Map<string, number>();

  assertNotLocked(key: string, now: number = Date.now()): void {
    const until = this.lockedUntil.get(key);
    if (until === undefined) {
      return;
    }
    if (until > now) {
      throw rateLimitedError(until, now);
    }
    this.lockedUntil.delete(key);
  }

  recordFailure(key: string, now: number = Date.now()): void {
    const next = (this.failures.get(key) ?? 0) + 1;
    if (next >= ACCESS_UNLOCK_FAIL_THRESHOLD) {
      this.lockedUntil.set(key, now + LOCK_WINDOW_MS);
      this.failures.delete(key);
    } else {
      this.failures.set(key, next);
    }
    if (this.failures.size > ACCESS_UNLOCK_MAX_TRACKED_KEYS) {
      this.reset();
    }
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
    this.lockedUntil.delete(key);
  }

  /** 供测试与排障观察，不参与判定（与 `LoginLockService.isLocked` 同一用途）。 */
  isLocked(key: string, now = Date.now()): boolean {
    const until = this.lockedUntil.get(key);
    return until !== undefined && until > now;
  }

  reset(): void {
    this.failures.clear();
    this.lockedUntil.clear();
  }
}

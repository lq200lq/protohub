import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import {
  ACCESS_UNLOCK_FAIL_THRESHOLD,
  ACCESS_UNLOCK_LOCK_SECONDS,
  ACCESS_UNLOCK_MAX_TRACKED_KEYS,
} from '../../config/constants';
import { unlockAttemptKey, UnlockRateLimiter } from './unlock-rate-limiter.service';

/**
 * 解锁限速器（接口设计 §9.2；迭代实施计划 M4-T7）。
 *
 * 阈值、键形状、"成功后清零"这三条在 `unlock.service.spec.ts` 里是**通过服务**验的，
 * 这里只补服务层碰不到的两面：内存封顶，以及锁到期后的自愈。
 */

const KEY = unlockAttemptKey({ ip: '203.0.113.9', projectCode: 'crm', prototypeCode: 'crm-p01' });
const LOCK_MS = ACCESS_UNLOCK_LOCK_SECONDS * 1000;

/** 打满阈值：`now` 默认取当前时间——锁的到期时间是从它推出来的，测试里两者必须同源。 */
function lockFiveTimes(limiter: UnlockRateLimiter, now = Date.now()): void {
  for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD; attempt += 1) {
    limiter.recordFailure(KEY, now);
  }
}

describe('键的形状', () => {
  it('IP 在前、链接在后；拿不到 IP 时留 no-ip 而不是抛异常', () => {
    expect(KEY).toBe('203.0.113.9|crm/crm-p01');
    expect(
      unlockAttemptKey({ ip: null, projectCode: 'crm', prototypeCode: 'crm-p01' }),
    ).toBe('no-ip|crm/crm-p01');
  });
});

describe('内存封顶（无上限的 Map 就是拿请求体打堆）', () => {
  it('失败键数超过上限即整体清空：宁可少计几次，不可 OOM', () => {
    const limiter = new UnlockRateLimiter();
    const now = 1_700_000_000_000;
    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD - 1; attempt += 1) {
      limiter.recordFailure(KEY, now);
    }

    // 塞进超过上限的其它键：这一步把整张表清掉
    for (let index = 0; index <= ACCESS_UNLOCK_MAX_TRACKED_KEYS; index += 1) {
      limiter.recordFailure(`203.0.113.${index % 254}|crm/p-${index}`, now);
    }

    // 封顶生效的证据就是这里：KEY 若还记着那 4 次，第 1 次就凑满 5 次被锁上了
    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD - 1; attempt += 1) {
      limiter.recordFailure(KEY, now);
    }
    expect(limiter.isLocked(KEY, now)).toBe(false);
    limiter.recordFailure(KEY, now);
    expect(limiter.isLocked(KEY, now)).toBe(true);
  });
});

describe('到期自愈', () => {
  it('未到点为锁；过了到期时间后，判锁顺带把这条记录删掉（不靠定时器）', () => {
    const limiter = new UnlockRateLimiter();
    const now = 1_700_000_000_000;
    lockFiveTimes(limiter, now);

    expect(limiter.isLocked(KEY, now)).toBe(true);
    expect(() => limiter.assertNotLocked(KEY, now)).toThrow(
      expect.objectContaining({ errorCode: ERROR_CODES.RATE_LIMITED }),
    );
    expect(limiter.isLocked(KEY, now + LOCK_MS + 1)).toBe(false);
    expect(() => limiter.assertNotLocked(KEY, now + LOCK_MS + 1)).not.toThrow();

    // 解过一次的键已经不占内存
    const fresh = new UnlockRateLimiter();
    fresh.recordFailure(KEY, now);
    fresh.assertNotLocked(KEY, now + LOCK_MS + 1);
    expect(fresh.isLocked(KEY, now)).toBe(false);
  });

  it('reset() 是给测试与排障用的，不参与判定', () => {
    const limiter = new UnlockRateLimiter();
    lockFiveTimes(limiter);
    expect(limiter.isLocked(KEY)).toBe(true);

    limiter.reset();

    expect(limiter.isLocked(KEY)).toBe(false);
  });
});

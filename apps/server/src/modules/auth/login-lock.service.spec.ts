import { HttpStatus } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import { ERROR_CODES } from '@protohub/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../../common/exception/business.exception';
import { LOGIN_FAIL_THRESHOLD, LOGIN_LOCK_SECONDS } from './auth.constants';
import { LoginLockService, attemptKey } from './login-lock.service';

interface FakeDb {
  readonly count: ReturnType<typeof vi.fn>;
  readonly db: PrismaClient;
}

function createFakeDb(count = 0): FakeDb {
  const countFn = vi.fn(async () => count);
  return {
    count: countFn,
    db: { sysLoginLog: { count: countFn } } as unknown as PrismaClient,
  };
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

const NOW = 1_700_000_000_000;

describe('LoginLockService（后端接口设计 §2.1：5 次失败锁 15 分钟，内存 + 落库两层）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('阈值与窗口就是文档值', () => {
    expect(LOGIN_FAIL_THRESHOLD).toBe(5);
    expect(LOGIN_LOCK_SECONDS).toBe(900);
  });

  it('第 5 次失败即上锁：429 + RATE_LIMITED，还带剩余分钟数', async () => {
    const fake = createFakeDb(0);
    const lock = new LoginLockService(fake.db);
    let queriesBeforeLock = 0;
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD - 1; i += 1) {
      lock.recordFailure('admin', '10.0.0.1');
      await expect(lock.assertNotLocked('admin', '10.0.0.1', NOW)).resolves.toBeUndefined();
      queriesBeforeLock = fake.count.mock.calls.length;
    }
    lock.recordFailure('admin', '10.0.0.1');
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(true);

    const error = await failure(lock.assertNotLocked('admin', '10.0.0.1', NOW));
    expect(error.httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.errorCode).toBe(ERROR_CODES.RATE_LIMITED);
    expect(error.message).toContain('15 分钟');
    // 内存已经判出锁定，不该再打库（锁定的每次尝试都是 O(1)）。
    expect(fake.count).toHaveBeenCalledTimes(queriesBeforeLock);
  });

  it('锁定按 username + ip：换 IP 或换用户名不受影响（分布式爆破不误伤）', () => {
    const lock = new LoginLockService(createFakeDb(0).db);
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i += 1) {
      lock.recordFailure('admin', '10.0.0.1');
    }
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(true);
    expect(lock.isLocked('admin', '10.0.0.2')).toBe(false);
    expect(lock.isLocked('other', '10.0.0.1')).toBe(false);
  });

  it('用户名大小写不敏感（Admin 和 admin 记在同一个计数上）', () => {
    const lock = new LoginLockService(createFakeDb(0).db);
    lock.recordFailure('Admin', '10.0.0.1');
    lock.recordFailure('ADMIN', '10.0.0.1');
    // 两次都记在同一个 key 上：第三次仍在同一计数里继续（没有各记各的）。
    expect(attemptKey('Admin', null)).toBe('admin|no-ip');
    expect(attemptKey('ADMIN', '10.0.0.1')).toBe(attemptKey('admin', '10.0.0.1'));
    lock.recordFailure('admin', '10.0.0.1');
    lock.recordFailure('ADMIN', '10.0.0.1');
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(false);
    lock.recordFailure('Admin', '10.0.0.1');
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(true);
  });

  it('登录成功清空计数与锁（否则用户迟早会被自己锁死）', async () => {
    const lock = new LoginLockService(createFakeDb(0).db);
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i += 1) {
      lock.recordFailure('admin', '10.0.0.1');
    }
    lock.recordSuccess('admin', '10.0.0.1');
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(false);
    await expect(
      lock.assertNotLocked('admin', '10.0.0.1', NOW),
    ).resolves.toBeUndefined();
  });

  it('内存锁到期后自动放行', async () => {
    const fake = createFakeDb(0);
    const lock = new LoginLockService(fake.db);
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i += 1) {
      lock.recordFailure('admin', '10.0.0.1');
    }
    const after = NOW + LOGIN_LOCK_SECONDS * 1_000 + 1;
    await expect(lock.assertNotLocked('admin', '10.0.0.1', after)).resolves.toBeUndefined();
  });

  it('重启后靠 sys_login_log 回补：内存是空的，窗口内 5 次失败照样锁上', async () => {
    const fake = createFakeDb(LOGIN_FAIL_THRESHOLD);
    const lock = new LoginLockService(fake.db);
    const error = await failure(lock.assertNotLocked('admin', '10.0.0.1', NOW));
    expect(error.httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(fake.count).toHaveBeenCalledWith({
      where: {
        loginType: 'login',
        success: false,
        username: { equals: 'admin', mode: 'insensitive' },
        createdAt: { gte: new Date(NOW - LOGIN_LOCK_SECONDS * 1_000) },
        ip: '10.0.0.1',
      },
    });
    // 回补出来的锁也写回内存，后续请求不再重复查库。
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(true);
    fake.count.mockClear();
    await expect(
      failure(lock.assertNotLocked('admin', '10.0.0.1', NOW + 1_000)),
    ).resolves.toBeDefined();
    expect(fake.count).not.toHaveBeenCalled();
  });

  it('窗口内失败次数不足则放行；取不到 ip 时不带 ip 条件（`ip: null` 不是可比较值）', async () => {
    const fake = createFakeDb(LOGIN_FAIL_THRESHOLD - 1);
    const lock = new LoginLockService(fake.db);
    await expect(lock.assertNotLocked('admin', null, NOW)).resolves.toBeUndefined();
    expect(fake.count).toHaveBeenCalledTimes(1);
    const args = fake.count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect('ip' in args.where).toBe(false);
    expect(args.where['username']).toEqual({ equals: 'admin', mode: 'insensitive' });
  });

  it('回补查询挂了不阻断登录（内存计数仍然生效）', async () => {
    const countFn = vi.fn(async () => {
      throw new Error('db down');
    });
    const db = { sysLoginLog: { count: countFn } } as unknown as PrismaClient;
    const lock = new LoginLockService(db);
    await expect(lock.assertNotLocked('admin', '10.0.0.1', NOW)).resolves.toBeUndefined();
    expect(countFn).toHaveBeenCalledTimes(1);
  });

  it('reset() 供测试与运维手工解锁', () => {
    const lock = new LoginLockService(createFakeDb(0).db);
    for (let i = 0; i < LOGIN_FAIL_THRESHOLD; i += 1) {
      lock.recordFailure('admin', '10.0.0.1');
    }
    lock.reset();
    expect(lock.isLocked('admin', '10.0.0.1')).toBe(false);
  });
});

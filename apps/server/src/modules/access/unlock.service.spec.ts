import { describe, expect, it, vi } from 'vitest';
import { argon2id, hash } from 'argon2';
import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../common/exception/business.exception';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import type { AccessOutcome } from './access.service';
import { AccessRepo, type UnlockRow } from './access.repo';
import { UnlockService, type UnlockRequest } from './unlock.service';
import { UnlockTokenService } from './unlock-token.service';
import { unlockAttemptKey, UnlockRateLimiter } from './unlock-rate-limiter.service';
import {
  ACCESS_UNLOCK_FAIL_THRESHOLD,
  ACCESS_UNLOCK_LOCK_SECONDS,
} from '../../config/constants';

/**
 * 解锁服务（接口设计 §9.2、机制 §5.2；迭代实施计划 M4-T7/T8）。
 *
 * 桩的只有两个"别人的实现"：取行（Prisma）与决策（`AccessService`，它的组合覆盖在
 * `access.service.spec.ts` 与 `decide-access.spec.ts` 里穷举过）。
 * argon2 用**真哈希**（参数调低到 2 MB / 1 轮，同 `auth.service.spec.ts` 的做法）——
 * 这一条接口存在的意义就是"设置时那个哈希，验的时候认"，桩掉它就等于什么都没测。
 * 令牌与限速同样用真实现：`cookieValue` 要能被 `UnlockTokenService.verify` 认下来，
 * 而"连续失败 5 次锁 10 分钟"是限速器与调用次序的**合力**，各自单测都盖不住。
 */

const PASSWORD = 'hunter2-pass';
const TARGET = { projectCode: 'crm', prototypeCode: 'crm-p01' };

const ENV = fakeAppEnv();
const TOKENS = new UnlockTokenService(ENV);

/** 参数调低的 argon2 哈希：单测要的是真格式往返，不是抗 GPU 强度（`timeCost` 的下界就是 2）。 */
async function hashOf(password: string): Promise<string> {
  return hash(password, { memoryCost: 2_100, parallelism: 1, timeCost: 2, type: argon2id });
}

function outcome(status: 200 | 401 | 403 | 404, reason?: string): AccessOutcome {
  return {
    decision: reason ? { reason: reason as never, status } : { status },
    projectId: '9',
    prototypeId: status === 401 || status === 200 ? '31' : null,
    sessionUserId: null,
  };
}

interface Harness {
  findUnlockRow: Mock;
  limiter: UnlockRateLimiter;
  service: UnlockService;
  unlock: (input?: Partial<UnlockRequest>) => Promise<unknown>;
}

type Mock = ReturnType<typeof vi.fn>;

function harness(input: {
  decide?: AccessOutcome;
  row?: UnlockRow | null;
}): Harness {
  const decide = input.decide ?? outcome(401, 'NEED_PASSWORD');
  const findUnlockRow = vi.fn(async () => input.row ?? null);
  const limiter = new UnlockRateLimiter();
  const service = new UnlockService(
    { findUnlockRow } as unknown as AccessRepo,
    { decide: vi.fn(async () => decide) } as unknown as import('./access.service').AccessService,
    limiter,
    TOKENS,
  );
  return {
    findUnlockRow,
    limiter,
    service,
    unlock: (patch = {}) =>
      service.unlock({
        ip: '203.0.113.9',
        password: PASSWORD,
        ...TARGET,
        ...patch,
      }),
  };
}

async function passwordRow(password = PASSWORD, policyVersion = 7): Promise<UnlockRow> {
  return {
    accessMode: 'password',
    id: '31',
    passwordHash: await hashOf(password),
    policyVersion,
  };
}

const keyOf = (patch: Partial<UnlockRequest> = {}) =>
  unlockAttemptKey({ ip: '203.0.113.9', ...TARGET, ...patch });

describe('密码正确：签发这一原型自己的解锁令牌', () => {
  it('返回 Cookie 名/Path/Max-Age，且令牌能被 verify 认下来', async () => {
    const { unlock } = harness({ row: await passwordRow() });

    const result = await unlock();

    expect(result).toMatchObject({
      cookieName: 'proto_access_p31',
      cookiePath: '/p/crm/crm-p01',
      kind: 'unlocked',
      maxAgeSeconds: 86_400,
    });
    const value = (result as { cookieValue: string }).cookieValue;
    expect(
      TOKENS.verify(value, { ...TARGET, policyVersion: 7 }),
    ).toBe(true);
  });

  it('段 2 用的是**行上**的 policy_version：改密码后（+1）旧令牌立刻验不过', async () => {
    const issued = (await harness({ row: await passwordRow(PASSWORD, 7) }).unlock()) as {
      cookieValue: string;
    };

    expect(issued.cookieValue.startsWith('v1.7.')).toBe(true);
    // 模拟改密码：policy_version 变 8，同一条令牌对该原型不再成立
    expect(TOKENS.verify(issued.cookieValue, { ...TARGET, policyVersion: 8 })).toBe(false);
  });

  it('Cookie 值里没有密码、也没有原型名（只有编码与签名）', async () => {
    const result = (await harness({ row: await passwordRow() }).unlock()) as {
      cookieValue: string;
    };

    expect(JSON.stringify(result.cookieValue)).not.toMatch(PASSWORD);
    expect(result.cookieValue.split('.')).toHaveLength(4);
  });
});

describe('非"要密码"的结论一律不进验密码那步', () => {
  it('public 档（决策 200）：already-open，连哈希都不去取', async () => {
    const { findUnlockRow, unlock } = harness({ decide: outcome(200) });

    expect(await unlock()).toEqual({ kind: 'already-open' });
    expect(findUnlockRow).not.toHaveBeenCalled();
  });

  it.each([
    ['NEED_LOGIN', 403],
    ['NO_PERMISSION', 403],
    ['PROTOTYPE_ARCHIVED', 403],
    ['PROJECT_ARCHIVED', 403],
    ['NOT_FOUND', 404],
    ['NOT_PUBLISHED', 404],
  ] as const)('%s → 原样转成 denied，不额外造状态', async (reason, status) => {
    const { findUnlockRow, unlock } = harness({ decide: outcome(status, reason) });

    expect(await unlock()).toEqual({ kind: 'denied', reason, status });
    expect(findUnlockRow).not.toHaveBeenCalled();
  });

  it('决策要凭据却没给出原型 id（数据与决策不一致）→ 404，不是 500', async () => {
    const { findUnlockRow, unlock } = harness({
      decide: { ...outcome(401, 'NEED_PASSWORD'), prototypeId: null },
    });

    expect(await unlock()).toEqual({ kind: 'denied', reason: 'NOT_FOUND', status: 404 });
    expect(findUnlockRow).not.toHaveBeenCalled();
  });

  it('行在两次查询之间被删掉 → 404', async () => {
    const { unlock } = harness({ row: null });

    expect(await unlock()).toEqual({ kind: 'denied', reason: 'NOT_FOUND', status: 404 });
  });
});

describe('密码不对：只有一种答案', () => {
  it('错的密码 → bad-password，并计入这一原型的失败次数', async () => {
    const { limiter, unlock } = harness({ row: await passwordRow('other-password') });

    expect(await unlock()).toEqual({ kind: 'bad-password' });
    expect(limiter.isLocked(keyOf())).toBe(false);
  });

  it.each([
    ['库里没设哈希（越界数据）', null],
    ['哈希不是 argon2 串（人工改库）', 'plain-text-looking'],
    ['空串密码', ''],
  ])('%s → 同样 bad-password，不抛 500 也不透露原因', async (_label, stored) => {
    const row: UnlockRow = {
      accessMode: 'password',
      id: '31',
      passwordHash: typeof stored === 'string' ? stored : null,
      policyVersion: 3,
    };
    const { unlock } = harness({ row });

    const result = await unlock(
      typeof stored === 'string' && stored === '' ? { password: '' } : {},
    );

    expect(result).toEqual({ kind: 'bad-password' });
  });

  it('模式已被改成 public（两次查询之间管理员动了手）→ 没有哈希可验，按密码错处理', async () => {
    const row: UnlockRow = {
      accessMode: 'public',
      id: '31',
      passwordHash: null,
      policyVersion: 3,
    };

    expect(await harness({ row }).unlock()).toEqual({ kind: 'bad-password' });
  });
});

describe('限速：同 IP 对同一原型连续失败 5 次锁 10 分钟', () => {
  it('第 5 次失败之后，第 6 次请求直接 429，连库都不碰', async () => {
    const { findUnlockRow, unlock } = harness({ row: await passwordRow('other-password') });

    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD; attempt += 1) {
      expect(await unlock()).toEqual({ kind: 'bad-password' });
    }
    findUnlockRow.mockClear();

    const error = await unlock().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).errorCode).toBe(ERROR_CODES.RATE_LIMITED);
    expect((error as BusinessException).httpStatus).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect((error as BusinessException).message).toMatch(/分钟后再试/);
    expect(findUnlockRow).not.toHaveBeenCalled();
  });

  it('锁按"IP + 这一条链接"：另一个原型的失败不受牵连', async () => {
    const { limiter, unlock } = harness({ row: await passwordRow('other-password') });
    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD; attempt += 1) {
      await unlock();
    }

    const other = unlock({ prototypeCode: 'crm-p02' });

    expect(await other).toEqual({ kind: 'bad-password' });
    expect(limiter.isLocked(keyOf({ prototypeCode: 'crm-p02' }))).toBe(false);
  });

  it('密码输对就清零："连续"失败才有意义，别人攒的次数不该锁住这一位', async () => {
    const wrong = harness({ row: await passwordRow('other-password') });
    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD - 1; attempt += 1) {
      await wrong.unlock();
    }

    const right = await wrong.unlock({ password: 'other-password' });
    expect(right).toMatchObject({ kind: 'unlocked' });

    // 计数已被成功清掉：再错 4 次仍不该锁
    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD - 1; attempt += 1) {
      expect(await wrong.unlock()).toEqual({ kind: 'bad-password' });
    }
    expect(wrong.limiter.isLocked(keyOf())).toBe(false);
  });

  it('锁满 10 分钟自动解（内存锁不该变成永久封禁）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { limiter, unlock } = harness({ row: await passwordRow('other-password') });
      for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD; attempt += 1) {
        await unlock();
      }
      expect(limiter.isLocked(keyOf())).toBe(true);
      await expect(unlock()).rejects.toBeInstanceOf(BusinessException);

      vi.setSystemTime(new Date(Date.now() + ACCESS_UNLOCK_LOCK_SECONDS * 1000 + 1));

      expect(limiter.isLocked(keyOf())).toBe(false);
      // 解锁之后还能继续验（这一次是第 1 次失败，不是被锁住）
      expect(await unlock()).toEqual({ kind: 'bad-password' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('服务不可达的 IP（拿不到来源）也照样进锁：键里留 no-ip 而不是抛异常', async () => {
    const { unlock } = harness({ row: await passwordRow('other-password') });

    for (let attempt = 0; attempt < ACCESS_UNLOCK_FAIL_THRESHOLD; attempt += 1) {
      await unlock({ ip: null });
    }

    expect(unlockAttemptKey({ ip: null, ...TARGET })).toContain('no-ip');
    await expect(unlock({ ip: null })).rejects.toBeInstanceOf(BusinessException);
  });
});

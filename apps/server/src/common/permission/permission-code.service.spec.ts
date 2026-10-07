import { PERMISSION_CODES } from '@protohub/shared';
import type { PrismaClient } from '@protohub/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PERMISSION_CACHE_TTL_MS,
  PermissionCodeService,
} from './permission-code.service';

interface FakeDb {
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly roleUserFindMany: ReturnType<typeof vi.fn>;
  readonly rolePermissionCalls: { where: unknown }[];
  readonly db: PrismaClient;
}

/** 只造这个服务真正用到的两张关联表：sysRolePermission（查码）和 sysUserRole（按角色失效）。 */
function createFakeDb(userIdsOfRole: readonly (string | number)[] = []): FakeDb {
  const rolePermissionCalls: { where: unknown }[] = [];
  const findMany = vi.fn((args: { where?: unknown } = {}) => {
    rolePermissionCalls.push({ where: args.where });
    return Promise.resolve(
      userIdsOfRole.map((userId) => ({
        userId: BigInt(userId),
        permission: { code: `code:${userId}` },
      })),
    );
  });
  const roleUserFindMany = vi.fn(async () =>
    userIdsOfRole.map((userId) => ({ userId: BigInt(userId) })),
  );
  const db = {
    sysRolePermission: { findMany },
    sysUserRole: { findMany: roleUserFindMany },
  };
  return { findMany, roleUserFindMany, rolePermissionCalls, db: db as unknown as PrismaClient };
}

const BASE_TIME = 1_700_000_000_000;

describe('PermissionCodeService（30 秒缓存 + 主动失效）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('30 秒内只查一次库：每个请求都联表查权限码会拖慢全部接口', async () => {
    const fake = createFakeDb([7]);
    const service = new PermissionCodeService(fake.db);
    expect(PERMISSION_CACHE_TTL_MS).toBe(30_000);

    await expect(service.codesOfUser('7')).resolves.toEqual(new Set(['code:7']));
    await service.codesOfUser('7');
    await service.codesOfUser('7');
    expect(fake.findMany).toHaveBeenCalledTimes(1);
    expect(service.cachedUserCount).toBe(1);

    // 时间刚过 TTL：缓存 miss，重新回库。
    vi.setSystemTime(BASE_TIME + PERMISSION_CACHE_TTL_MS + 1);
    await service.codesOfUser('7');
    expect(fake.findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser 后下一个请求立刻回库（改用户角色用）', async () => {
    const fake = createFakeDb([7, 8]);
    const service = new PermissionCodeService(fake.db);
    await service.codesOfUser('7');
    expect(fake.findMany).toHaveBeenCalledTimes(1);
    await service.invalidateUser('7');
    expect(service.cachedUserCount).toBe(0);
    await service.codesOfUser('7');
    expect(fake.findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidateRole 清掉该角色下所有用户（改角色权限用，后端接口设计 §7.2.6）', async () => {
    const fake = createFakeDb([7, 8]);
    const service = new PermissionCodeService(fake.db);
    await service.codesOfUser('7');
    await service.codesOfUser('8');
    expect(service.cachedUserCount).toBe(2);

    await service.invalidateRole('3');

    expect(fake.roleUserFindMany).toHaveBeenCalledWith({
      where: { roleId: BigInt(3) },
      select: { userId: true },
    });
    expect(service.cachedUserCount).toBe(0);
    await service.codesOfUser('7');
    expect(fake.findMany).toHaveBeenCalledTimes(3);
  });

  it('invalidateRole 传非数字 ID 不打库也不清缓存（避免 BigInt 抛异常把管理端接口打成 500）', async () => {
    const fake = createFakeDb([7]);
    const service = new PermissionCodeService(fake.db);
    await service.codesOfUser('7');
    await service.invalidateRole('abc');
    expect(fake.roleUserFindMany).not.toHaveBeenCalled();
    expect(service.cachedUserCount).toBe(1);
  });

  it('invalidateAll 兜底清空', async () => {
    const fake = createFakeDb([7, 8]);
    const service = new PermissionCodeService(fake.db);
    await service.codesOfUser('7');
    await service.codesOfUser('8');
    service.invalidateAll();
    expect(service.cachedUserCount).toBe(0);
    expect(fake.findMany).toHaveBeenCalledTimes(2);
  });

  it('查库条件只带启用的、未删除的角色（禁用角色残留的授权不能继续生效）', async () => {
    const fake = createFakeDb([7]);
    const service = new PermissionCodeService(fake.db);
    await service.codesOfUser('7');
    expect(fake.rolePermissionCalls[0]?.where).toEqual({
      role: { deletedAt: null, status: 1, userRoles: { some: { userId: BigInt(7) } } },
    });
  });

  it('codeList：超管给全集（C-5），普通用户按常量顺序过滤（顺序稳定，前端可快照）', async () => {
    const fake = createFakeDb([7]);
    const service = new PermissionCodeService(fake.db);

    const superAdmin = await service.codeList('7', true);
    expect(superAdmin).toEqual([...PERMISSION_CODES]);
    expect(fake.findMany).not.toHaveBeenCalled();

    // 库里只有 code:7，不在权限码常量里 → 过滤后为空，且顺序由 PERMISSION_CODES 决定。
    expect(await service.codeList('7', false)).toEqual([]);

    const fakeMatched = createFakeDb();
    fakeMatched.findMany.mockResolvedValue(
      PERMISSION_CODES.slice(0, 3).map((code) => ({ permission: { code } })),
    );
    const matched = new PermissionCodeService(fakeMatched.db);
    await expect(matched.codeList('9', false)).resolves.toEqual(
      PERMISSION_CODES.slice(0, 3),
    );
  });

  it('非数字用户 ID 直接当无权限（BigInt 会抛，Guard 只该看到空集合）', async () => {
    const fake = createFakeDb([7]);
    const service = new PermissionCodeService(fake.db);
    await expect(service.codesOfUser('not-a-number')).resolves.toEqual(new Set());
    expect(fake.findMany).not.toHaveBeenCalled();
  });
});

import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@protohub/db';
import { describe, expect, it, vi } from 'vitest';

import { AppEnvService } from '../../../config/app-env.service';
import { PermissionCodeService } from '../../../common/permission/permission-code.service';
import { PermissionModule } from '../../../common/permission/permission.module';
import { PRISMA_CLIENT } from '../../../common/permission/prisma-client';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import { CacheInvalidation } from './cache-invalidation.service';
import { PermissionCacheModule } from './permission-cache.module';

interface FakeDb {
  readonly db: PrismaClient;
  /** 查权限码的次数：用它判断"这一趟是命中缓存还是回了库"。 */
  readonly codeQuery: ReturnType<typeof vi.fn>;
}

/** 只造失效链路用到的两张关联表（与 permission-code.service.spec 同形）。 */
function fakeDb(userIds: readonly (string | number)[]): FakeDb {
  // 按查询里的 userId 过滤，好让"缓存里是谁"这件事可断言。
  const codeQuery = vi.fn(
    async (args: { where?: { role?: { userRoles?: { some?: { userId?: bigint } } } } }) => {
      const wanted = args?.where?.role?.userRoles?.some?.userId;
      return userIds
        .filter((userId) => wanted === undefined || BigInt(userId) === wanted)
        .map((userId) => ({ permission: { code: `code:${userId}` } }));
    },
  );
  const db = {
    sysRolePermission: { findMany: codeQuery },
    sysUserRole: {
      findMany: vi.fn(async () =>
        userIds.map((userId) => ({ userId: BigInt(userId) })),
      ),
    },
  } as unknown as PrismaClient;
  return { codeQuery, db };
}

/**
 * 测试宿主：把 `PermissionModule` 需要的底座依赖（配置、Prisma、Reflector）以 global
 * 模块的形式喂进去——Nest 的 DI 是按模块作用域找 provider 的，把这些直接写在测试
 * root 模块的 providers 里，被 import 的 PermissionModule 看不见。
 */
@Global()
@Module({})
class HostModule {
  static forFakes(fake: FakeDb): DynamicModule {
    return {
      module: HostModule,
      global: true,
      providers: [
        Reflector,
        { provide: PRISMA_CLIENT, useValue: fake.db },
        { provide: AppEnvService, useValue: fakeAppEnv({ NODE_ENV: 'test' }) },
      ],
      exports: [Reflector, PRISMA_CLIENT, AppEnvService],
    };
  }
}

@Module({
  imports: [PermissionModule, PermissionCacheModule],
})
class WiringModule {}

/**
 * 接线回归测试（M1 Gate G4）。
 *
 * 第一版失败原因：system 侧给失效令牌兜了个 Noop 实现，改角色权限返回 200，
 * 但旧令牌解析出来的权限码 30 秒内纹丝不动。`permission-code.service.spec` 全绿也抓不到它——
 * 那个测的是 service 自身的逻辑，不是 DI 图。所以这里断言的是"两个模块共用同一份缓存"。
 */
describe('权限码缓存失效接线（G4：改权限即时生效，不等 30 秒 TTL）', () => {
  async function compile(userIds: readonly (string | number)[] = [7, 8]) {
    const fake = fakeDb(userIds);
    const app = await Test.createTestingModule({
      imports: [HostModule.forFakes(fake), WiringModule],
    }).compile();
    return { app, fake };
  }

  it('写侧失效器与读侧缓存是同一个实例：forRole/forUser/forAll 都立刻清掉缓存', async () => {
    const { app, fake } = await compile();
    const codes = app.get(PermissionCodeService);
    const invalidation = app.get(CacheInvalidation);

    await expect(codes.codesOfUser('7')).resolves.toEqual(new Set(['code:7']));
    await codes.codesOfUser('8');
    expect(codes.cachedUserCount).toBe(2);
    expect(fake.codeQuery).toHaveBeenCalledTimes(2);

    await invalidation.forRole('3');
    expect(codes.cachedUserCount).toBe(0);

    await codes.codesOfUser('7');
    await codes.codesOfUser('8');
    // forUser 只清这一个人：另一个用户仍在缓存里（不用为一处改动把全量权限码打回库）。
    await invalidation.forUser('7');
    expect(codes.cachedUserCount).toBe(1);

    await codes.codesOfUser('7');
    await invalidation.forAll();
    expect(codes.cachedUserCount).toBe(0);
    await app.close();
  });

  it('失效后再取权限码要重新回库（撤销的码不会再从缓存里漏出来）', async () => {
    const { app, fake } = await compile([7]);
    const codes = app.get(PermissionCodeService);

    await codes.codesOfUser('7');
    expect(fake.codeQuery).toHaveBeenCalledTimes(1);

    await app.get(CacheInvalidation).forRole('3');
    await codes.codesOfUser('7');
    expect(fake.codeQuery).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

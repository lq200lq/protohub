import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { Actor, RequestMeta } from '../common/actor';
import type { CacheInvalidation } from '../permission-cache/cache-invalidation.service';
import type { OperationAuditWriter } from '../audit/operation-audit.writer';
import { RoleService, toRoleDetail, toRoleListItem, type RoleRow } from './role.service';
import type { UpdateRoleInput } from './role.dto';

/**
 * RoleService 单测（后端接口设计 §7.2 + 权限模型设计 §4 C-1 + §8.2 缓存失效 + F-6 软删除）。
 * Prisma 用 vi.fn 桩（同 common/permission/permission-code.service.spec.ts 的做法）：
 * 只造本服务真正触碰的表，断言 where/调用次序，而不是验证 Prisma 本身。
 */

const ACTOR: Actor = {
  userId: '1',
  username: 'admin',
  roles: ['super_admin'],
  isSuperAdmin: true,
  dataScope: 'all',
};
const REQUEST: RequestMeta = { method: 'POST', path: '/api/system/roles', ip: '127.0.0.1' };

function roleRow(overrides: Partial<RoleRow> = {}): RoleRow {
  return {
    id: 7n,
    code: 'qa_lead',
    name: '质量负责人',
    dataScope: 'member',
    builtIn: false,
    sort: 10,
    status: 1,
    remark: null,
    ...overrides,
  };
}

function detailRow(
  overrides: Partial<RoleRow> & {
    readonly permissionCodes?: readonly string[];
    readonly menuIds?: readonly (string | number)[];
  } = {},
): RoleRow & {
  rolePermissions: { permission: { code: string } }[];
  roleMenus: { menuId: bigint }[];
} {
  const { permissionCodes = ['system:user:read'], menuIds = ['3'], ...rest } = overrides;
  return {
    ...roleRow(rest),
    rolePermissions: permissionCodes.map((code) => ({ permission: { code } })),
    roleMenus: menuIds.map((id) => ({ menuId: BigInt(id) })),
  };
}

interface FakeRoleDb {
  sysRole: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  sysUserRole: { count: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
  sysPermission: { findMany: ReturnType<typeof vi.fn> };
  sysMenu: { findMany: ReturnType<typeof vi.fn> };
  sysRolePermission: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  sysRoleMenu: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

function createFakeDb(): FakeRoleDb & { db: PrismaClient } {
  const fake: FakeRoleDb = {
    sysRole: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(roleRow()),
      update: vi.fn().mockResolvedValue(roleRow()),
    },
    sysUserRole: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    sysPermission: { findMany: vi.fn().mockResolvedValue([]) },
    sysMenu: { findMany: vi.fn().mockResolvedValue([]) },
    sysRolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    sysRoleMenu: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(),
  };
  fake.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      sysRolePermission: fake.sysRolePermission,
      sysRoleMenu: fake.sysRoleMenu,
    }),
  );
  return { ...fake, db: fake as unknown as PrismaClient };
}

function createService(fake: FakeRoleDb & { db: PrismaClient }) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as OperationAuditWriter;
  const cache = {
    forUser: vi.fn().mockResolvedValue(undefined),
    forRole: vi.fn().mockResolvedValue(undefined),
    forAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as CacheInvalidation;
  return { service: new RoleService(fake.db, audit, cache), audit, cache };
}

/** BusinessException 断言 helper：既验 errorCode 也验它是业务错而不是裸异常。 */
async function expectBusiness(code: string, call: () => Promise<unknown>): Promise<Error> {
  const error = await call().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  const business = error as Error & { errorCode?: string; httpStatus?: number };
  expect(business.errorCode).toBe(code);
  expect(business.httpStatus ?? 400).toBeLessThan(500);
  return business;
}

describe('RoleService.list（§7.2.1）', () => {
  const fake = createFakeDb();
  const { service } = createService(fake);

  it('每条查询都过滤软删除（F-6），userCount 只数未删用户', async () => {
    fake.sysRole.findMany.mockResolvedValue([roleRow()]);
    fake.sysUserRole.groupBy.mockResolvedValue([{ roleId: 7n, _count: { _all: 3 } }]);

    const items = await service.list();

    expect(fake.sysRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
    expect(fake.sysUserRole.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ user: { deletedAt: null }, role: { deletedAt: null } }),
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({ id: '7', code: 'qa_lead', userCount: 3, dataScope: 'member' }),
    ]);
  });
});

describe('RoleService.detail（§7.2.2）', () => {
  it('返回 permissionCodes 与 menuIds；角色不存在 404', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(detailRow({ permissionCodes: ['system:role:list'], menuIds: ['11', '12'] }));

    const detail = await service.detail('7');
    expect(detail.permissionCodes).toEqual(['system:role:list']);
    expect(detail.menuIds).toEqual(['11', '12']);

    fake.sysRole.findFirst.mockResolvedValue(null);
    await expectBusiness('ROLE_NOT_FOUND', () => service.detail('999'));
  });

  it('id 非数字直接 400，不落库', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    const error = await expectBusiness('PARAM_INVALID', () => service.detail('abc'));
    expect(error.message).toContain('数字');
    expect(fake.sysRole.findFirst).not.toHaveBeenCalled();
  });
});

describe('RoleService.create（§7.2.3）', () => {
  it('code 在未删集合内撞重 → 400，且不写库', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(roleRow());

    await expectBusiness('PARAM_INVALID', () =>
      service.create(ACTOR, { code: 'qa_lead', name: 'X', dataScope: 'member' }, REQUEST),
    );
    // assertCodeFree 的占用判定也必须排除软删行（唯一索引 WHERE deleted_at IS NULL 同口径）。
    expect(fake.sysRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
    expect(fake.sysRole.create).not.toHaveBeenCalled();
  });

  it('成功路径：写库 + 审计 create，不写缓存（新角色下没有用户）', async () => {
    const fake = createFakeDb();
    const { service, audit, cache } = createService(fake);
    fake.sysRole.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(roleRow({ builtIn: false }));
    fake.sysRole.create.mockResolvedValue(roleRow());

    const item = await service.create(
      ACTOR,
      { code: 'qa_lead', name: '质量负责人', dataScope: 'member', sort: 10 },
      REQUEST,
    );
    expect(fake.sysRole.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: 'qa_lead', dataScope: 'member' }),
    });
    expect(item.code).toBe('qa_lead');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', module: 'system:role' }));
    expect(cache.forRole).not.toHaveBeenCalled();
  });
});

describe('RoleService.update（§7.2.4 + C-1）', () => {
  it('code 不可改：任何带 code 的输入都 400 ROLE_CODE_IMMUTABLE', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    // DTO 层已拒 code（见 role.dto.spec）；这里验服务层的第二道兜底，所以刻意绕过类型契约。
    await expectBusiness('ROLE_CODE_IMMUTABLE', () =>
      service.update(
        ACTOR,
        '7',
        { name: 'X', dataScope: 'all', code: 'hacked' } as UpdateRoleInput,
        REQUEST,
      ),
    );
    expect(fake.sysRole.update).not.toHaveBeenCalled();
  });

  it('改 status（停用角色）会即时失效该角色下所有用户的权限缓存（§8.2）', async () => {
    const fake = createFakeDb();
    const { service, cache } = createService(fake);
    fake.sysRole.findFirst
      .mockResolvedValueOnce(detailRow({ status: 1 }))
      .mockResolvedValueOnce(detailRow({ status: 0 }));

    await service.update(ACTOR, '7', { name: '质量负责人', dataScope: 'member', status: 0 }, REQUEST);
    expect(cache.forRole).toHaveBeenCalledWith('7');
    // 软删过滤同样出现在取行 where 里（F-6）。
    expect(fake.sysRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }),
    );
  });
});

describe('RoleService.remove（§7.2.5 + C-1）', () => {
  it('内置角色不可删（ROLE_BUILT_IN_PROTECTED）', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(roleRow({ code: 'super_admin', builtIn: true }));

    const error = await expectBusiness('ROLE_BUILT_IN_PROTECTED', () => service.remove(ACTOR, '7', REQUEST));
    expect(error.message).toContain('内置');
    expect(fake.sysRole.update).not.toHaveBeenCalled();
  });

  it('仍有用户绑定时 400 ROLE_IN_USE（只数未软删的用户）', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(roleRow());
    fake.sysUserRole.count.mockResolvedValue(2);

    await expectBusiness('ROLE_IN_USE', () => service.remove(ACTOR, '7', REQUEST));
    expect(fake.sysUserRole.count).toHaveBeenCalledWith({
      where: { roleId: 7n, user: { deletedAt: null } },
    });
  });

  it('成功路径：软删除 + 缓存失效 + 审计快照', async () => {
    const fake = createFakeDb();
    const { service, audit, cache } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(roleRow());

    await service.remove(ACTOR, '7', REQUEST);
    expect(fake.sysRole.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7n }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(cache.forRole).toHaveBeenCalledWith('7');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }));
  });
});

describe('RoleService.assignPermissions（§7.2.6）', () => {
  it('未知权限码整体拒绝，不碰事务', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(detailRow());

    const error = await expectBusiness('PARAM_INVALID', () =>
      service.assignPermissions(
        ACTOR,
        '7',
        { permissionCodes: ['system:role:list', 'proto:nope'], menuIds: [] },
        REQUEST,
      ),
    );
    expect(error.message).toContain('proto:nope');
    expect(fake.$transaction).not.toHaveBeenCalled();
  });

  it('菜单 id 不存在 → 400，不写库', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(detailRow());
    fake.sysPermission.findMany.mockResolvedValue([{ id: 1n, code: 'system:role:list' }]);
    fake.sysMenu.findMany.mockResolvedValue([]);

    await expectBusiness('PARAM_INVALID', () =>
      service.assignPermissions(
        ACTOR,
        '7',
        { permissionCodes: ['system:role:list'], menuIds: ['404'] },
        REQUEST,
      ),
    );
    expect(fake.sysRolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it('覆盖式写入 + 主动失效该角色缓存（"保存后即时生效"）+ 审计记增删', async () => {
    const fake = createFakeDb();
    const { service, audit, cache } = createService(fake);
    fake.sysRole.findFirst
      .mockResolvedValueOnce(detailRow({ permissionCodes: ['system:user:read'], menuIds: ['3'] }))
      .mockResolvedValueOnce(detailRow({ permissionCodes: ['system:role:list'], menuIds: ['3', '9'] }));
    fake.sysPermission.findMany.mockResolvedValue([{ id: 5n, code: 'system:role:list' }]);
    fake.sysMenu.findMany.mockResolvedValue([{ id: 3n }, { id: 9n }]);

    const detail = await service.assignPermissions(
      ACTOR,
      '7',
      { permissionCodes: ['system:role:list'], menuIds: ['3', '9'] },
      REQUEST,
    );

    expect(fake.sysRolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 7n } });
    expect(fake.sysRolePermission.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 7n, permissionId: 5n }],
    });
    expect(fake.sysRoleMenu.createMany).toHaveBeenCalledWith({
      data: [{ roleId: 7n, menuId: 3n }, { roleId: 7n, menuId: 9n }],
    });
    expect(cache.forRole).toHaveBeenCalledWith('7');
    expect(detail.permissionCodes).toEqual(['system:role:list']);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'assign_permission',
        detail: expect.objectContaining({
          permissions: expect.objectContaining({
            added: ['system:role:list'],
            removed: ['system:user:read'],
          }),
        }),
      }),
    );
  });

  it('字典表缺行（seed 没跑齐）报人话 400 而不是 FK 炸 500', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysRole.findFirst.mockResolvedValue(detailRow());
    fake.sysPermission.findMany.mockResolvedValue([]);

    const error = await expectBusiness('PARAM_INVALID', () =>
      service.assignPermissions(
        ACTOR,
        '7',
        { permissionCodes: ['system:role:list'], menuIds: [] },
        REQUEST,
      ),
    );
    expect(error.message).toContain('seed');
  });
});

describe('role 映射纯函数', () => {
  it('非法 dataScope 按最窄兜底；toRoleDetail 只透出字典内的码', () => {
    const item = toRoleListItem(roleRow({ dataScope: 'wild' }), 2);
    expect(item.dataScope).toBe('own');
    expect(item.userCount).toBe(2);

    const detail = toRoleDetail(
      detailRow({ permissionCodes: ['system:role:list', 'legacy:gone'] }),
      0,
    );
    expect(detail.permissionCodes).toEqual(['system:role:list']);
  });
});

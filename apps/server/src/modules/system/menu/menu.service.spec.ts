import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { Actor, RequestMeta } from '../common/actor';
import type { CacheInvalidation } from '../permission-cache/cache-invalidation.service';
import type { OperationAuditWriter } from '../audit/operation-audit.writer';
import { MenuService, buildTree, toMenuNode, type MenuRow } from './menu.service';
import { menuFormSchema } from './menu.dto';

/**
 * MenuService 单测（后端接口设计 §7.3）。
 * 重点：树形组装、MENU_HAS_CHILDREN、auth_code 字典校验、component 形态校验（一致性脚本管文件存在性）。
 */

const ACTOR: Actor = { userId: '1', username: 'admin', roles: ['super_admin'], isSuperAdmin: true, dataScope: 'all' };
const REQUEST: RequestMeta = { method: 'POST', path: '/api/system/menus', ip: '127.0.0.1' };

function menuRow(overrides: Partial<MenuRow> = {}): MenuRow {
  return {
    id: 1n,
    pid: null,
    type: 'catalog',
    name: 'Proto',
    title: '原型管理',
    path: '/proto',
    component: 'BasicLayout',
    authCode: null,
    icon: 'lucide:folder-code',
    sort: 10,
    status: 1,
    keepAlive: false,
    affixTab: false,
    hideInMenu: false,
    menuVisibleWithForbidden: false,
    authority: null,
    ignoreAccess: false,
    openInNewWindow: false,
    iframeSrc: null,
    linkUrl: null,
    badge: null,
    badgeType: null,
    ...overrides,
  };
}

interface FakeMenuDb {
  sysMenu: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

function createFakeDb(): FakeMenuDb & { db: PrismaClient } {
  const fake: FakeMenuDb = {
    sysMenu: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => menuRow(data as Partial<MenuRow>)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => menuRow(data as Partial<MenuRow>)),
      delete: vi.fn().mockResolvedValue(menuRow()),
    },
  };
  return { ...fake, db: fake as unknown as PrismaClient };
}

function createService(fake: FakeMenuDb & { db: PrismaClient }) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as OperationAuditWriter;
  const cache = {
    forUser: vi.fn().mockResolvedValue(undefined),
    forRole: vi.fn().mockResolvedValue(undefined),
    forAll: vi.fn().mockResolvedValue(undefined),
  } as unknown as CacheInvalidation;
  return { service: new MenuService(fake.db, audit, cache), audit, cache };
}

async function expectBusiness(code: string, call: () => Promise<unknown>): Promise<Error> {
  const error = await call().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error & { errorCode?: string }).errorCode).toBe(code);
  return error as Error;
}

const baseForm = {
  type: 'menu',
  name: 'SystemRole',
  title: '角色管理',
  path: '/system/role',
  component: '/system/role/index',
} as const;

describe('MenuService.tree（§7.3.1）', () => {
  it('按 pid 组树，button 节点保留在树里（角色授权界面以它为骨架）', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysMenu.findMany.mockResolvedValue([
      menuRow({ id: 1n }),
      menuRow({ id: 2n, pid: 1n, type: 'menu', name: 'SystemRole', title: '角色管理' }),
      menuRow({ id: 3n, pid: 2n, type: 'button', name: 'RoleCreate', title: '新建角色', authCode: 'system:role:create', path: null, component: null }),
    ]);

    const tree = await service.tree();
    expect(fake.sysMenu.findMany).toHaveBeenCalledWith({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({
      type: 'button',
      authCode: 'system:role:create',
    });
  });

  it('孤儿节点（父不存在）提升为根而不是丢', () => {
    const nodes = [menuRow({ id: 9n, pid: 404n })].map(toMenuNode);
    expect(buildTree(nodes).map((node) => node.id)).toEqual(['9']);
  });
});

describe('menu.dto 形态校验', () => {
  it('auth_code 必须在 PERMISSIONS 字典内（权限模型 §3.7），乱码拒绝', () => {
    expect(menuFormSchema.safeParse({ ...baseForm, authCode: 'system:role:create' }).success).toBe(true);
    const bad = menuFormSchema.safeParse({ ...baseForm, type: 'button', authCode: 'system:role:fly' });
    expect(bad.success).toBe(false);
  });

  it('component 只验形态：视图路径或大写组件名；.. 上跳与空格拒绝（文件存在性归一致性脚本）', () => {
    expect(menuFormSchema.safeParse({ ...baseForm, component: '/proto/project/index' }).success).toBe(true);
    expect(menuFormSchema.safeParse({ ...baseForm, component: 'BasicLayout' }).success).toBe(true);
    expect(menuFormSchema.safeParse({ ...baseForm, component: 'IFrameView' }).success).toBe(true);
    expect(menuFormSchema.safeParse({ ...baseForm, component: '../evil/index' }).success).toBe(false);
    expect(menuFormSchema.safeParse({ ...baseForm, component: '/a/../../b' }).success).toBe(false);
    expect(menuFormSchema.safeParse({ ...baseForm, component: 'proto project' }).success).toBe(false);
  });

  it('type/name/path 契约：PascalCase name、站内 path、非法 type 拒绝', () => {
    expect(menuFormSchema.safeParse({ ...baseForm, type: 'tab' }).success).toBe(false);
    expect(menuFormSchema.safeParse({ ...baseForm, name: 'system-role' }).success).toBe(false);
    expect(menuFormSchema.safeParse({ ...baseForm, path: 'system/role' }).success).toBe(false);
    // button 节点允许 path/component 为空。
    expect(menuFormSchema.safeParse({ type: 'button', name: 'RoleCreate', title: '新建角色', authCode: 'system:role:create' }).success).toBe(true);
  });
});

describe('MenuService.create（§7.3.2）', () => {
  it('父节点必须存在；button 下不许挂子节点', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    // 第一次 findFirst：父存在性检查（返回 button），第二次：撞名检查。
    fake.sysMenu.findFirst
      .mockResolvedValueOnce(menuRow({ id: 5n, type: 'button' }))
      .mockResolvedValueOnce(null);
    await expectBusiness('PARAM_INVALID', () =>
      service.create(ACTOR, { ...baseForm, pid: '5' }, REQUEST),
    );

    fake.sysMenu.findFirst.mockResolvedValueOnce(null);
    await expectBusiness('MENU_NOT_FOUND', () =>
      service.create(ACTOR, { ...baseForm, pid: '404' }, REQUEST),
    );
    expect(fake.sysMenu.create).not.toHaveBeenCalled();
  });

  it('name 撞重（唯一索引 uk_sys_menu_name）→ 400 人话', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValueOnce(menuRow({ id: 2n, name: 'SystemRole' }));
    const error = await expectBusiness('PARAM_INVALID', () => service.create(ACTOR, baseForm, REQUEST));
    expect(error.message).toContain('SystemRole');
    expect(fake.sysMenu.create).not.toHaveBeenCalled();
  });

  it('成功：落库 + 审计 create', async () => {
    const fake = createFakeDb();
    const { service, audit } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(null);

    const node = await service.create(ACTOR, { ...baseForm, authCode: 'system:role:list' }, REQUEST);
    expect(fake.sysMenu.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'SystemRole', authCode: 'system:role:list', status: 1 }),
    });
    expect(node.title).toBe('角色管理');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ module: 'system:menu', action: 'create' }));
  });
});

describe('MenuService.update（§7.3.3）', () => {
  it('目标不存在 → 404 MENU_NOT_FOUND', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    await expectBusiness('MENU_NOT_FOUND', () => service.update(ACTOR, '404', baseForm, REQUEST));
  });

  it('防环：不能把菜单挂到自己的子孙下面', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(menuRow({ id: 1n }));
    // 祖先链：2 的父是 1（自己）。把 1 挂到 2 下应拒绝。
    fake.sysMenu.findMany.mockResolvedValue([
      { id: 1n, pid: null },
      { id: 2n, pid: 1n },
    ]);
    await expectBusiness('PARAM_INVALID', () => service.update(ACTOR, '1', { ...baseForm, pid: '2' }, REQUEST));
    expect(fake.sysMenu.update).not.toHaveBeenCalled();
  });

  it('改 status 会全量失效权限缓存（下发集合变了）', async () => {
    const fake = createFakeDb();
    const { service, cache } = createService(fake);
    // 第一次 findFirst 取目标行；之后的（撞名检查）返回 null。
    fake.sysMenu.findFirst
      .mockResolvedValueOnce(menuRow({ id: 1n, status: 1 }))
      .mockResolvedValue(null);
    await service.update(ACTOR, '1', { ...baseForm, status: 0 }, REQUEST);
    expect(cache.forAll).toHaveBeenCalledTimes(1);
  });
});

describe('MenuService.setStatus（启停）', () => {
  it('值相同则幂等短路，不写库', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(menuRow({ id: 1n, status: 1 }));
    await service.setStatus(ACTOR, '1', 1, REQUEST);
    expect(fake.sysMenu.update).not.toHaveBeenCalled();
  });

  it('停用：update status=0 + 审计 action=disable + 缓存全量失效', async () => {
    const fake = createFakeDb();
    const { service, audit, cache } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(menuRow({ id: 1n, status: 1 }));
    fake.sysMenu.update.mockResolvedValue(menuRow({ id: 1n, status: 0 }));

    await service.setStatus(ACTOR, '1', 0, REQUEST);
    expect(fake.sysMenu.update).toHaveBeenCalledWith({
      where: { id: 1n },
      data: { status: 0, updatedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'disable' }));
    expect(cache.forAll).toHaveBeenCalledTimes(1);
  });
});

describe('MenuService.remove（§7.3.4）', () => {
  it('有子节点 → 400 MENU_HAS_CHILDREN（sys_menu 无软删列，物理删除前必须拆树）', async () => {
    const fake = createFakeDb();
    const { service } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(menuRow({ id: 1n }));
    fake.sysMenu.count.mockResolvedValue(3);

    const error = await expectBusiness('MENU_HAS_CHILDREN', () => service.remove(ACTOR, '1', REQUEST));
    expect(error.message).toContain('3');
    expect(fake.sysMenu.delete).not.toHaveBeenCalled();
  });

  it('叶子节点：删除 + 全量缓存失效 + 审计快照', async () => {
    const fake = createFakeDb();
    const { service, audit, cache } = createService(fake);
    fake.sysMenu.findFirst.mockResolvedValue(menuRow({ id: 1n }));
    fake.sysMenu.count.mockResolvedValue(0);

    await service.remove(ACTOR, '1', REQUEST);
    expect(fake.sysMenu.delete).toHaveBeenCalledWith({ where: { id: 1n } });
    expect(cache.forAll).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }));
  });
});

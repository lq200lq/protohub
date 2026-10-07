import type { PrismaClient } from '@protohub/db';
import { describe, expect, it, vi } from 'vitest';

import type { AuthUser } from '../../common/permission/auth-user';
import type { PermissionCodeService } from '../../common/permission/permission-code.service';
import { MenuService } from './menu.service';

/** sysMenu.findMany 返回的行（列名与数据库设计 §4.1 对齐）。 */
interface Row {
  readonly id: bigint;
  readonly pid: bigint | null;
  readonly type: string;
  readonly name: string;
  readonly title: string;
  readonly path: string | null;
  readonly component: string | null;
  readonly authCode: string | null;
  readonly icon: string | null;
  readonly sort: number;
  readonly keepAlive: boolean;
  readonly affixTab: boolean;
  readonly hideInMenu: boolean;
  readonly menuVisibleWithForbidden: boolean;
  readonly authority: string | null;
  readonly ignoreAccess: boolean;
  readonly openInNewWindow: boolean;
  readonly iframeSrc: string | null;
  readonly linkUrl: string | null;
  readonly badge: string | null;
  readonly badgeType: string | null;
}

/** 测试里用普通数字写 id，进 mock 时才转 bigint（贴近库里 BigInt 的真实形态）。 */
type RowInput = Partial<Omit<Row, 'id' | 'pid'>> & {
  readonly id: number;
  readonly pid?: number | null;
};

function menu(input: RowInput): Row {
  const { id, pid, ...rest } = input;
  return {
    type: 'catalog',
    name: `M${id}`,
    title: `菜单${id}`,
    path: `/m${id}`,
    component: null,
    authCode: null,
    icon: null,
    sort: id,
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
    ...rest,
    id: BigInt(id),
    pid: pid === undefined || pid === null ? null : BigInt(pid),
  };
}

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: '7',
    username: 'publisher01',
    realName: '发布者',
    avatar: null,
    email: null,
    phone: null,
    roles: ['publisher'],
    primaryRoleName: '发布者',
    dataScope: 'own',
    forcePasswordChange: false,
    tokenVersion: 0,
    ...overrides,
  };
}

interface Harness {
  readonly service: MenuService;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly roleMenuFindMany: ReturnType<typeof vi.fn>;
  readonly codesOfUser: ReturnType<typeof vi.fn>;
}

function harness(rows: readonly Row[], grantedMenuIds: readonly number[], ownedCodes: readonly string[] = []): Harness {
  const findMany = vi.fn(async () => rows.map((row) => ({ ...row })));
  const roleMenuFindMany = vi.fn(async () =>
    grantedMenuIds.map((id) => ({ menuId: BigInt(id) })),
  );
  const codesOfUser = vi.fn(async () => new Set(ownedCodes));
  const db = {
    sysMenu: { findMany },
    sysRoleMenu: { findMany: roleMenuFindMany },
  } as unknown as PrismaClient;
  return {
    service: new MenuService(
      db,
      { codesOfUser } as unknown as PermissionCodeService,
    ),
    findMany,
    roleMenuFindMany,
    codesOfUser,
  };
}

describe('MenuService（sys_menu → vben 路由树，后端接口设计 §2.6）', () => {
  it('按钮节点根本不查（前端 accessMode=backend 用不了按钮，权限码走 /auth/codes）', async () => {
    const h = harness([], []);
    await h.service.routesFor(user());
    expect(h.findMany).toHaveBeenCalledWith({
      where: { status: 1, type: { not: 'button' } },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  });

  it('角色-菜单只认启用且未删除的角色', async () => {
    const h = harness([], []);
    await h.service.routesFor(user({ roles: ['publisher', 'viewer'] }));
    expect(h.roleMenuFindMany).toHaveBeenCalledWith({
      where: {
        role: { deletedAt: null, status: 1, code: { in: ['publisher', 'viewer'] } },
      },
      select: { menuId: true },
    });
  });

  it('可见性取并集：勾了菜单 或 拥有该节点的 auth_code', async () => {
    const rows = [
      menu({ id: 1, name: 'Proto', path: '/proto', authCode: 'proto:prototype:list' }),
      menu({ id: 2, name: 'System', path: '/system', authCode: 'system:user:list' }),
      menu({ id: 3, name: 'Trash', path: '/trash' }),
    ];
    // 只勾了 3 号（无 authCode 的目录），并且拥有 1 号的权限码。
    const h = harness(rows, [3], ['proto:prototype:list']);
    const tree = await h.service.routesFor(user());
    expect(tree.map((node) => node.name)).toEqual(['Proto', 'Trash']);
  });

  it('子节点可见时把父链补上（否则前端拿到的是一堆没有入口的孤儿路由）', async () => {
    const rows = [
      menu({ id: 10, name: 'Proto', path: '/proto' }),
      menu({ id: 11, name: 'ProtoList', path: '/proto/list', pid: 10 }),
      menu({ id: 12, name: 'ProtoDetail', path: '/proto/detail', pid: 10 }),
    ];
    const h = harness(rows, [12]);
    const tree = await h.service.routesFor(user());
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe('Proto');
    expect(tree[0]?.children?.map((child) => child.name)).toEqual(['ProtoDetail']);
  });

  it('super_admin 看全部，且不查权限码（C-5）', async () => {
    const rows = [menu({ id: 1, name: 'A' }), menu({ id: 2, name: 'B', authCode: 'system:user:delete' })];
    const h = harness(rows, []);
    const tree = await h.service.routesFor(user({ roles: ['super_admin', 'admin'] }));
    expect(tree.map((node) => node.name)).toEqual(['A', 'B']);
    expect(h.codesOfUser).not.toHaveBeenCalled();
  });

  it('meta 按 vben 契约映射：只在为真时输出开关，authority 逗号串拆成数组', async () => {
    const rows = [
      menu({
        id: 1,
        name: 'Workspace',
        path: '/dashboard/workspace',
        component: '/dashboard/workspace/index',
        icon: 'lucide:layout-dashboard',
        sort: 7,
        keepAlive: true,
        affixTab: true,
        badge: 'beta',
        badgeType: 'warning',
        authority: 'admin, publisher ',
      }),
    ];
    const h = harness(rows, [1]);
    const [route] = await h.service.routesFor(user({ roles: ['super_admin'] }));
    expect(route).toEqual({
      name: 'Workspace',
      path: '/dashboard/workspace',
      component: '/dashboard/workspace/index',
      meta: {
        title: '菜单1',
        order: 7,
        icon: 'lucide:layout-dashboard',
        keepAlive: true,
        affixTab: true,
        badge: 'beta',
        badgeType: 'warning',
        authority: ['admin', 'publisher'],
      },
    });
  });

  it('hideInMenu / menuVisibleWithForbidden / ignoreAccess / openInNewWindow 为真才带', async () => {
    const rows = [
      menu({ id: 1, name: 'On', hideInMenu: true, ignoreAccess: true }),
      menu({ id: 2, name: 'Off' }),
    ];
    const h = harness(rows, [1, 2]);
    const tree = await h.service.routesFor(user({ roles: ['super_admin'] }));
    expect(tree[0]?.meta).toMatchObject({ hideInMenu: true, ignoreAccess: true });
    expect('hideInMenu' in (tree[1]?.meta ?? {})).toBe(false);
    expect('openInNewWindow' in (tree[1]?.meta ?? {})).toBe(false);
  });

  it('embedded/link 固定编译成 IFrameView，并把地址搬进 meta', async () => {
    const rows = [
      menu({ id: 1, name: 'Doc', type: 'embedded', path: '/doc', iframeSrc: 'https://example.com/a' }),
      menu({ id: 2, name: 'Blog', type: 'link', path: '/blog', linkUrl: 'https://example.com/b' }),
    ];
    const h = harness(rows, [1, 2]);
    const tree = await h.service.routesFor(user({ roles: ['super_admin'] }));
    expect(tree[0]).toMatchObject({
      component: 'IFrameView',
      meta: { iframeSrc: 'https://example.com/a' },
    });
    expect(tree[1]).toMatchObject({
      component: 'IFrameView',
      meta: { link: 'https://example.com/b' },
    });
  });

  it('库里出现 pid 环：只丢这一棵子树，其他节点照常返回（脏数据不该把接口打挂）', async () => {
    const rows = [
      menu({ id: 1, name: 'Root', path: '/' }),
      menu({ id: 2, name: 'CycleA', pid: 3 }),
      menu({ id: 3, name: 'CycleB', pid: 2 }),
    ];
    const h = harness(rows, [1, 2, 3]);
    const tree = await h.service.routesFor(user({ roles: ['super_admin'] }));
    expect(tree.map((node) => node.name)).toEqual(['Root']);
  });

  it('父节点被停用（查不到）时提升为根，菜单不丢', async () => {
    const rows = [menu({ id: 21, name: 'Orphan', pid: 999 })];
    const h = harness(rows, [21]);
    const tree = await h.service.routesFor(user());
    expect(tree.map((node) => node.name)).toEqual(['Orphan']);
  });

  it('没有任何菜单时返回空数组（不是 null，前端 map 会炸）', async () => {
    const h = harness([], []);
    await expect(h.service.routesFor(user())).resolves.toEqual([]);
  });

  it('无权限用户不查码表之外的东西：授权为空则整棵树为空', async () => {
    const rows = [menu({ id: 1, name: 'A', authCode: 'system:user:list' })];
    const h = harness(rows, []);
    await expect(h.service.routesFor(user())).resolves.toEqual([]);
    expect(h.codesOfUser).toHaveBeenCalledWith('7');
  });
});

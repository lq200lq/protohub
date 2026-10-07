import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import type { MenuRouteTree, RouteMeta, RouteRecordStringComponent } from '@protohub/shared';

import { SUPER_ADMIN_ROLE } from '../../common/permission/account.service';
import type { AuthUser } from '../../common/permission/auth-user';
import { PermissionCodeService } from '../../common/permission/permission-code.service';
import { PRISMA_CLIENT } from '../../common/permission/prisma-client';

const BUTTON_TYPE = 'button';
/** vben 对 embedded/link 两类节点的固定组件名（后端接口设计 §2.6）。 */
const IFRAME_VIEW = 'IFrameView';

/** 只取树形映射要用的列（结构化声明，不把 Prisma 生成类型带到签名上）。 */
interface MenuRow {
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

function splitList(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  return items.length > 0 ? items : undefined;
}

function toMeta(row: MenuRow): RouteMeta {
  const meta: RouteMeta = { title: row.title, order: row.sort };
  const icon = row.icon;
  if (icon) {
    meta.icon = icon;
  }
  if (row.keepAlive) {
    meta.keepAlive = true;
  }
  if (row.affixTab) {
    meta.affixTab = true;
  }
  if (row.hideInMenu) {
    meta.hideInMenu = true;
  }
  if (row.menuVisibleWithForbidden) {
    meta.menuVisibleWithForbidden = true;
  }
  if (row.ignoreAccess) {
    meta.ignoreAccess = true;
  }
  if (row.openInNewWindow) {
    meta.openInNewWindow = true;
  }
  const badge = row.badge;
  if (badge) {
    meta.badge = badge;
    const badgeType = row.badgeType;
    if (badgeType) {
      meta.badgeType = badgeType;
    }
  }
  const authority = splitList(row.authority);
  if (authority) {
    meta.authority = authority;
  }
  return meta;
}

function toComponent(row: MenuRow, meta: RouteMeta): string {
  if (row.type === 'embedded') {
    const src = row.iframeSrc;
    if (src) {
      meta.iframeSrc = src;
    }
    return IFRAME_VIEW;
  }
  if (row.type === 'link') {
    const link = row.linkUrl;
    if (link) {
      meta.link = link;
    }
    return IFRAME_VIEW;
  }
  return row.component ?? '';
}

/**
 * `sys_menu` → vben 路由树（后端接口设计 §2.6）。
 *
 * 可见性判定取**并集**：角色勾了这个菜单（`sys_role_menu`）**或**该节点携带的权限码
 * （`auth_code`）在该用户的能力集里。只按 `sys_role_menu` 判会让"忘了勾菜单但给了权限码"
 * 的角色整个侧栏空白——而 M1-T3 的 seed 是幂等"只增不减"的，新加的菜单节点必然缺
 * 角色-菜单关联，这条兜底不是可选项。
 */
@Injectable()
export class MenuService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly permissionCodes: PermissionCodeService,
  ) {}

  async routesFor(user: AuthUser): Promise<MenuRouteTree> {
    const [rows, grants] = await Promise.all([
      this.db.sysMenu.findMany({
        where: { status: 1, type: { not: BUTTON_TYPE } },
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      }),
      this.db.sysRoleMenu.findMany({
        where: {
          role: { deletedAt: null, status: 1, code: { in: [...user.roles] } },
        },
        select: { menuId: true },
      }),
    ]);
    if (rows.length === 0) {
      return [];
    }

    const superAdmin = user.roles.includes(SUPER_ADMIN_ROLE);
    const codes = superAdmin ? null : await this.permissionCodes.codesOfUser(user.userId);
    const granted = new Set(grants.map((grant) => grant.menuId.toString()));
    const byId = new Map(rows.map((row) => [row.id.toString(), row]));

    const isVisible = (row: MenuRow): boolean => {
      // C-5：超管看得到所有启用的节点，不依赖 sys_role_menu 是否勾全。
      if (superAdmin) {
        return true;
      }
      if (granted.has(row.id.toString())) {
        return true;
      }
      const authCode = row.authCode;
      // 目录节点（authCode 为空）只能靠角色-菜单或子孙节点出现，见下面的祖先补齐。
      return authCode !== null && (codes?.has(authCode) ?? false);
    };

    const visible = new Map<string, MenuRow>();
    for (const row of rows) {
      if (!isVisible(row)) {
        continue;
      }
      visible.set(row.id.toString(), row);
      // 子节点可见时把父链补上，否则前端拿到的是一堆没有入口的孤儿路由。
      for (
        let parent = row.pid === null ? undefined : byId.get(row.pid.toString());
        parent !== undefined;
        parent =
          parent.pid === null ? undefined : byId.get(parent.pid.toString())
      ) {
        if (visible.has(parent.id.toString())) {
          break;
        }
        visible.set(parent.id.toString(), parent);
      }
    }

    return buildTree([...visible.values()]);
  }
}

function toRoute(row: MenuRow, children: MenuRouteTree): RouteRecordStringComponent {
  const meta = toMeta(row);
  const route: RouteRecordStringComponent = {
    name: row.name,
    path: row.path ?? '',
    component: toComponent(row, meta),
    meta,
  };
  if (children.length > 0) {
    route.children = children;
  }
  return route;
}

/**
 * 在可见集合内按 pid 组树；父节点不在集合里的节点提升为根。
 *
 * 入参 rows 保持查询给的顺序（sort 升序、id 升序），所以这里不再二次排序。
 * 万一库里出现 pid 环：环上的节点会因为"父节点也在可见集合里"而全都成不了根，
 * 于是整环被自然丢弃——不会无限递归，前端只是少一棵子树（脏数据不该把接口打挂）。
 */
function buildTree(rows: readonly MenuRow[]): MenuRouteTree {
  const childrenOf = new Map<string, MenuRow[]>();
  const roots: MenuRow[] = [];
  const known = new Set(rows.map((row) => row.id.toString()));
  for (const row of rows) {
    const parentId = row.pid === null ? null : row.pid.toString();
    if (parentId !== null && parentId !== row.id.toString() && known.has(parentId)) {
      const list = childrenOf.get(parentId);
      if (list) {
        list.push(row);
      } else {
        childrenOf.set(parentId, [row]);
      }
    } else {
      roots.push(row);
    }
  }
  const render = (row: MenuRow): RouteRecordStringComponent =>
    toRoute(
      row,
      (childrenOf.get(row.id.toString()) ?? []).map((child) => render(child)),
    );
  return roots.map((row) => render(row));
}

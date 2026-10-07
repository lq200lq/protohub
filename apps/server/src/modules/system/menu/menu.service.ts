import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ERROR_CODES,
  type MenuTreeNode,
  type UserStatus,
} from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { PRISMA_CLIENT } from '../persistence/prisma-token';
import type { Actor, RequestMeta } from '../common/actor';
import {
  buildChangeDiff,
  snapshotDetail,
} from '../common/audit-diff';
import { parseIdParam } from '../common/dto';
import { CacheInvalidation } from '../permission-cache/cache-invalidation.service';
import { OperationAuditWriter } from '../audit/operation-audit.writer';
import type { MenuFormInput } from './menu.dto';

/**
 * 系统管理·菜单（后端接口设计 §7.3）。
 *
 * 与其它 sys_* 表不同，`sys_menu` **没有软删除列**（数据库设计 §4.1.6：菜单删除即物理删，
 * 角色关联靠 FK 级联），所以这里没有 deleted_at 过滤——F-6 的软删除约束适用于 user/role。
 * 停用（status=0）才是菜单的"下线"方式：auth/menu.service 的 /menu/all 只下发启用节点。
 */

/** 结构化声明，不把 Prisma 生成类型带上签名。 */
export interface MenuRow {
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
  readonly status: number;
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

@Injectable()
export class MenuService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly audit: OperationAuditWriter,
    private readonly cache: CacheInvalidation,
  ) {}

  /** §7.3.1 全量树（含 button 节点，不分页）。 */
  async tree(): Promise<MenuTreeNode[]> {
    const rows = await this.db.sysMenu.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    return buildTree(rows.map(toMenuNode));
  }

  /** §7.3.2 新建菜单/按钮。name 全局唯一；pid 必须存在。 */
  async create(
    actor: Actor,
    input: MenuFormInput,
    request: RequestMeta,
  ): Promise<MenuTreeNode> {
    const pid = this.toPid(input.pid);
    await this.assertParentExists(pid);
    await this.assertNameFree(input.name, null);

    let row: MenuRow;
    try {
      row = await this.db.sysMenu.create({
        data: { ...toFormData(input, pid), status: input.status ?? 1 },
      });
    } catch (error: unknown) {
      throw uniqueNameConflict(error);
    }
    await this.audit.record({
      actor,
      request,
      module: 'system:menu',
      action: 'create',
      resourceType: 'menu',
      resourceId: row.id.toString(),
      resourceName: row.title,
      detail: snapshotDetail(pickMenuAuditedFields(row)),
    });
    return toMenuNode(row);
  }

  /**
   * §7.3.3 编辑。表单是**覆盖式**提交（MenuFormParams 全量字段），未提供的可选字段落 null/false；
   * status 单独走 §7.3 的启停动作时不经过这里。
   */
  async update(
    actor: Actor,
    id: string,
    input: MenuFormInput,
    request: RequestMeta,
  ): Promise<MenuTreeNode> {
    const menuId = parseIdParam(id, '菜单 id');
    const before = await this.requireRow(menuId);
    const pid = this.toPid(input.pid);
    await this.assertParentExists(pid);
    await this.assertNoCycle(menuId, pid);
    await this.assertNameFree(input.name, menuId);

    let row: MenuRow;
    try {
      row = await this.db.sysMenu.update({
        where: { id: menuId },
        data: {
          ...toFormData(input, pid),
          status: input.status ?? before.status,
          updatedAt: new Date(),
        },
      });
    } catch (error: unknown) {
      throw uniqueNameConflict(error);
    }
    if (row.status !== before.status) {
      // 停用/启用改变 /menu/all 的下发结果与角色可见性，即时失效权限缓存（§8.2 同源考虑）。
      await this.cache.forAll();
    }
    await this.audit.record({
      actor,
      request,
      module: 'system:menu',
      action: 'update',
      resourceType: 'menu',
      resourceId: menuId.toString(),
      resourceName: row.title,
      detail: buildChangeDiff(
        pickMenuAuditedFields(before),
        pickMenuAuditedFields(row),
      ),
    });
    return toMenuNode(row);
  }

  /** 启停：status=1 启用 / 0 停用（停用不下发给前端路由）。 */
  async setStatus(
    actor: Actor,
    id: string,
    status: UserStatus,
    request: RequestMeta,
  ): Promise<MenuTreeNode> {
    const menuId = parseIdParam(id, '菜单 id');
    const before = await this.requireRow(menuId);
    if (before.status === status) {
      return toMenuNode(before);
    }
    const row = await this.db.sysMenu.update({
      where: { id: menuId },
      data: { status, updatedAt: new Date() },
    });
    await this.cache.forAll();
    await this.audit.record({
      actor,
      request,
      module: 'system:menu',
      action: status === 1 ? 'enable' : 'disable',
      resourceType: 'menu',
      resourceId: menuId.toString(),
      resourceName: row.title,
      detail: { snapshot: { status } },
    });
    return toMenuNode(row);
  }

  /** §7.3.4 删除：有子节点时 400 MENU_HAS_CHILDREN；物理删除（sys_menu 无软删除列）。 */
  async remove(actor: Actor, id: string, request: RequestMeta): Promise<{ id: string }> {
    const menuId = parseIdParam(id, '菜单 id');
    const row = await this.requireRow(menuId);
    const childCount = await this.db.sysMenu.count({ where: { pid: menuId } });
    if (childCount > 0) {
      throw new BusinessException(
        `该菜单下还有 ${childCount} 个子节点，请先删除子节点`,
        ERROR_CODES.MENU_HAS_CHILDREN,
        400,
      );
    }
    await this.db.sysMenu.delete({ where: { id: menuId } });
    // 菜单变更影响所有用户的可见路由，即时全量失效（30 秒 TTL 是兜底）。
    await this.cache.forAll();
    await this.audit.record({
      actor,
      request,
      module: 'system:menu',
      action: 'delete',
      resourceType: 'menu',
      resourceId: menuId.toString(),
      resourceName: row.title,
      detail: snapshotDetail(pickMenuAuditedFields(row)),
    });
    return { id: menuId.toString() };
  }

  // ---------------------------------------------------------------------------
  // 内部：取数与校验
  // ---------------------------------------------------------------------------

  private async requireRow(id: bigint): Promise<MenuRow> {
    const row = await this.db.sysMenu.findFirst({ where: { id } });
    if (!row) {
      throw new BusinessException('菜单不存在', ERROR_CODES.MENU_NOT_FOUND, 404);
    }
    return row;
  }

  private toPid(raw: string | null | undefined): bigint | null {
    return raw === undefined || raw === null || raw === '' ? null : parseIdParam(raw, '父菜单 id');
  }

  private async assertParentExists(pid: bigint | null): Promise<void> {
    if (pid === null) {
      return;
    }
    const parent = await this.db.sysMenu.findFirst({
      where: { id: pid },
      select: { id: true, type: true },
    });
    if (!parent) {
      throw new BusinessException(
        `父菜单不存在（id：${pid.toString()}）`,
        ERROR_CODES.MENU_NOT_FOUND,
        400,
      );
    }
    if (parent.type === 'button') {
      throw new BusinessException(
        '按钮节点不能有子节点，请选择目录或菜单作为父级',
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
  }

  /**
   * 防环：把节点挂到自己的子孙下会让 /menu/all 建树时整条子链丢失（子孙提升不到根）。
   * 沿 pid 链向上走，遇到自己就拒绝；库里若已有脏环，这条链最多走全表长度。
   */
  private async assertNoCycle(menuId: bigint, pid: bigint | null): Promise<void> {
    if (pid === null) {
      return;
    }
    const parents = await this.db.sysMenu.findMany({ select: { id: true, pid: true } });
    const parentOf = new Map(parents.map((row) => [row.id.toString(), row.pid?.toString() ?? null]));
    const target = menuId.toString();
    let cursor: string | null | undefined = pid.toString();
    const visited = new Set<string>();
    while (cursor !== null && cursor !== undefined) {
      if (cursor === target) {
        throw new BusinessException(
          '不能把菜单移动到自己或自己的子孙节点下面',
          ERROR_CODES.PARAM_INVALID,
          400,
        );
      }
      // 库里若已有脏环：visited 兜底，循环最多多走一遍链长就退出，不会挂死。
      if (visited.has(cursor)) {
        break;
      }
      visited.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  /** name 全局唯一（uk_sys_menu_name）；excludeId 用于"改自己不算撞名"。 */
  private async assertNameFree(name: string, excludeId: bigint | null): Promise<void> {
    const conflict = await this.db.sysMenu.findFirst({
      where: { name, ...(excludeId === null ? {} : { id: { not: excludeId } }) },
      select: { id: true },
    });
    if (conflict) {
      throw new BusinessException(
        `路由 name「${name}」已被其它菜单使用，请换一个`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// 映射（纯函数，导出给单测直接断言）
// -----------------------------------------------------------------------------

export function toMenuNode(row: MenuRow): MenuTreeNode {
  return {
    id: row.id.toString(),
    pid: row.pid === null ? null : row.pid.toString(),
    type: row.type as MenuTreeNode['type'],
    name: row.name,
    title: row.title,
    path: row.path,
    component: row.component,
    authCode: row.authCode,
    icon: row.icon,
    sort: row.sort,
    status: row.status === 0 ? 0 : 1,
    keepAlive: row.keepAlive,
    affixTab: row.affixTab,
    hideInMenu: row.hideInMenu,
    menuVisibleWithForbidden: row.menuVisibleWithForbidden,
    authority: row.authority,
    ignoreAccess: row.ignoreAccess,
    openInNewWindow: row.openInNewWindow,
    iframeSrc: row.iframeSrc,
    linkUrl: row.linkUrl,
    badge: row.badge,
    badgeType: row.badgeType,
    children: [],
  };
}

/** 按 pid 组树；父不存在的节点提升为根（与 auth/menu.service 的建树口径一致）。 */
export function buildTree(nodes: readonly MenuTreeNode[]): MenuTreeNode[] {
  const childrenOf = new Map<string, MenuTreeNode[]>();
  const roots: MenuTreeNode[] = [];
  const known = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    const pid = node.pid;
    if (pid !== null && pid !== node.id && known.has(pid)) {
      const list = childrenOf.get(pid);
      if (list) {
        list.push(node);
      } else {
        childrenOf.set(pid, [node]);
      }
    } else {
      roots.push(node);
    }
  }
  const render = (node: MenuTreeNode): MenuTreeNode => ({
    ...node,
    children: (childrenOf.get(node.id) ?? []).map((child) => render(child)),
  });
  return roots.map((node) => render(node));
}

/** 可进审计的菜单字段白名单。 */
export function pickMenuAuditedFields(row: MenuRow): Record<string, unknown> {
  return {
    pid: row.pid === null ? null : row.pid.toString(),
    type: row.type,
    name: row.name,
    title: row.title,
    path: row.path,
    component: row.component,
    authCode: row.authCode,
    sort: row.sort,
    status: row.status,
  };
}

/** 覆盖式表单数据：可选项未传即 null/false（与前端"整表单回传"的语义一致）。 */
function toFormData(input: MenuFormInput, pid: bigint | null): Prisma.SysMenuUncheckedCreateInput & Prisma.SysMenuUncheckedUpdateInput {
  return {
    pid,
    type: input.type,
    name: input.name,
    title: input.title,
    path: input.path ?? null,
    component: input.component ?? null,
    authCode: input.authCode ?? null,
    icon: input.icon ?? null,
    sort: input.sort ?? 0,
    keepAlive: input.keepAlive ?? false,
    affixTab: input.affixTab ?? false,
    hideInMenu: input.hideInMenu ?? false,
    menuVisibleWithForbidden: input.menuVisibleWithForbidden ?? false,
    ignoreAccess: input.ignoreAccess ?? false,
    openInNewWindow: input.openInNewWindow ?? false,
    authority: input.authority ?? null,
    iframeSrc: input.iframeSrc ?? null,
    linkUrl: input.linkUrl ?? null,
    badge: input.badge ?? null,
    badgeType: input.badgeType ?? null,
  };
}

/** P2002（并发撞 name 唯一索引）翻译成人话 400。 */
function uniqueNameConflict(error: unknown): unknown {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'P2002'
  ) {
    return new BusinessException(
      '路由 name 已存在（可能是并发创建冲突），请重试',
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  return error;
}

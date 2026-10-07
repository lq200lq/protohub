import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ERROR_CODES,
  isPermissionCode,
  type PermissionCode,
  type RoleDetail,
  type RoleListItem,
} from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { PRISMA_CLIENT } from '../persistence/prisma-token';
import type { Actor, RequestMeta } from '../common/actor';
import {
  buildChangeDiff,
  buildSetDiff,
  snapshotDetail,
} from '../common/audit-diff';
import { toDataScope } from '../common/data-scope';
import { parseIdParam } from '../common/dto';
import { CacheInvalidation } from '../permission-cache/cache-invalidation.service';
import { OperationAuditWriter } from '../audit/operation-audit.writer';
import type { CreateRoleInput, UpdateRoleInput } from './role.dto';

/**
 * 系统管理·角色（后端接口设计 §7.2 + 权限模型设计 §4 约束 C-1）。
 *
 * 与 user.service 同源的硬规则：
 * 1. **软删除**：`sys_role` 的每条查询都带 `deletedAt: null`（计划 §8 F-6），
 *    且 `uk_sys_role_code` 是条件唯一索引（WHERE deleted_at IS NULL），漏过滤会让
 *    "已删角色的 code 永远占位"或"未删判定算上已删行"两头出错。
 * 2. **缓存失效**：改角色权限/状态/删除都要 `cache.forRole`（§8.2 + §7.2.6"保存后即时生效"）。
 */

/** 结构化声明而不是把 Prisma 生成类型带上签名（与 common/permission/account.service.ts 同法）。 */
export interface RoleRow {
  readonly id: bigint;
  readonly code: string;
  readonly name: string;
  readonly dataScope: string;
  readonly builtIn: boolean;
  readonly sort: number;
  readonly status: number;
  readonly remark: string | null;
}

interface RoleDetailRow extends RoleRow {
  readonly rolePermissions: readonly { readonly permission: { readonly code: string } }[];
  readonly roleMenus: readonly { readonly menuId: bigint }[];
}

const ROLE_DETAIL_INCLUDE = {
  rolePermissions: { include: { permission: { select: { code: true } } } },
  roleMenus: { select: { menuId: true } },
} as const;

@Injectable()
export class RoleService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly audit: OperationAuditWriter,
    private readonly cache: CacheInvalidation,
  ) {}

  /** §7.2.1 全量列表（角色数量少，不分页），每行带 userCount。 */
  async list(): Promise<RoleListItem[]> {
    const where: Prisma.SysRoleWhereInput = { deletedAt: null };
    const [rows, counts] = await Promise.all([
      this.db.sysRole.findMany({ where, orderBy: [{ sort: 'asc' }, { id: 'asc' }] }),
      this.db.sysUserRole.groupBy({
        by: ['roleId'],
        // 只数未软删的用户：删掉的账号不该继续让角色"看起来在用"而挡删除。
        where: { role: { deletedAt: null }, user: { deletedAt: null } },
        _count: { _all: true },
      }),
    ]);
    const countOf = new Map(counts.map((c) => [c.roleId.toString(), c._count._all]));
    return rows.map((row) => toRoleListItem(row, countOf.get(row.id.toString()) ?? 0));
  }

  /** §7.2.2 详情：含 permissionCodes[] 与 menuIds[]。 */
  async detail(id: string): Promise<RoleDetail> {
    const roleId = parseIdParam(id, '角色 id');
    return this.buildDetail(await this.requireDetailRow(roleId));
  }

  /** §7.2.3 新建角色；code 在未删集合内唯一。 */
  async create(
    actor: Actor,
    input: CreateRoleInput,
    request: RequestMeta,
  ): Promise<RoleListItem> {
    await this.assertCodeFree(input.code, null);
    let createdId: bigint;
    try {
      const role = await this.db.sysRole.create({
        data: {
          code: input.code,
          name: input.name,
          dataScope: input.dataScope,
          sort: input.sort ?? 0,
          remark: input.remark ?? null,
        },
      });
      createdId = role.id;
    } catch (error: unknown) {
      throw uniqueCodeConflict(error);
    }
    const row = await this.requireRow(createdId);
    await this.audit.record({
      actor,
      request,
      module: 'system:role',
      action: 'create',
      resourceType: 'role',
      resourceId: createdId.toString(),
      resourceName: row.name,
      detail: snapshotDetail(pickRoleAuditedFields(row)),
    });
    return toRoleListItem(row, 0);
  }

  /**
   * §7.2.4 编辑（name/dataScope/sort/status/remark）。
   * C-1 的"code 不可改"在这里是**普适**的：update 契约根本没有 code 字段（DTO `.strict()` 拒收），
   * 服务层再兜一道——即便调用方构造出带 code 的对象也不会写库。
   */
  async update(
    actor: Actor,
    id: string,
    input: UpdateRoleInput,
    request: RequestMeta,
  ): Promise<RoleDetail> {
    if ('code' in input) {
      throw new BusinessException(
        '角色标识（code）不可修改',
        ERROR_CODES.ROLE_CODE_IMMUTABLE,
        400,
      );
    }
    const roleId = parseIdParam(id, '角色 id');
    const before = await this.requireDetailRow(roleId);

    await this.db.sysRole.update({
      where: { id: roleId },
      data: {
        name: input.name,
        dataScope: input.dataScope,
        sort: input.sort ?? before.sort,
        status: input.status === undefined ? before.status : input.status,
        remark: input.remark ?? null,
        // schema 的 updated_at 没有 @updatedAt，必须显式写（同 user.service）。
        updatedAt: new Date(),
      },
    });

    const after = await this.requireDetailRow(roleId);
    if (after.status !== before.status) {
      // 角色停用/启用改变该角色下所有用户的权限码（§8.2）。
      await this.cache.forRole(roleId.toString());
    }
    await this.audit.record({
      actor,
      request,
      module: 'system:role',
      action: 'update',
      resourceType: 'role',
      resourceId: roleId.toString(),
      resourceName: after.name,
      detail: buildChangeDiff(
        pickRoleAuditedFields(before),
        pickRoleAuditedFields(after),
      ),
    });
    return this.buildDetail(after);
  }

  /** §7.2.5 删除（软删除）：内置角色不可删（C-1）；仍有用户绑定时 ROLE_IN_USE。 */
  async remove(actor: Actor, id: string, request: RequestMeta): Promise<{ id: string }> {
    const roleId = parseIdParam(id, '角色 id');
    const row = await this.requireRow(roleId);
    if (row.builtIn) {
      throw new BusinessException(
        `内置角色「${row.name}」不可删除`,
        ERROR_CODES.ROLE_BUILT_IN_PROTECTED,
        400,
      );
    }
    const userCount = await this.db.sysUserRole.count({
      where: { roleId, user: { deletedAt: null } },
    });
    if (userCount > 0) {
      throw new BusinessException(
        `该角色仍绑定 ${userCount} 个用户，请先解除绑定`,
        ERROR_CODES.ROLE_IN_USE,
        400,
      );
    }

    await this.db.sysRole.update({
      where: { id: roleId },
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });
    await this.cache.forRole(roleId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:role',
      action: 'delete',
      resourceType: 'role',
      resourceId: roleId.toString(),
      resourceName: row.name,
      detail: snapshotDetail(pickRoleAuditedFields(row)),
    });
    return { id: roleId.toString() };
  }

  /**
   * §7.2.6 覆盖式授权：写 `sys_role_permission` + `sys_role_menu`，记审计，
   * 并**主动失效该角色下所有用户的权限码缓存**（文档明文要求，"保存后即时生效"）。
   */
  async assignPermissions(
    actor: Actor,
    id: string,
    // 结构上比 shared 的 AssignRolePermissionsParams 宽（code 先按 string 进，再走 isPermissionCode 校验），
    // 这样 DTO 不需要在 zod 里做字面量联合断言，未知码能给出人话 400 而不是通用校验错。
    input: { readonly menuIds: readonly string[]; readonly permissionCodes: readonly string[] },
    request: RequestMeta,
  ): Promise<RoleDetail> {
    const roleId = parseIdParam(id, '角色 id');
    const before = await this.requireDetailRow(roleId);

    const unknownCodes = input.permissionCodes.filter((code) => !isPermissionCode(code));
    if (unknownCodes.length > 0) {
      throw new BusinessException(
        `权限码不在系统字典中：${unknownCodes.join('、')}`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    const permissionIds = await this.resolvePermissionIds(input.permissionCodes);
    const menuIds = await this.resolveMenuIds(input.menuIds);

    await this.db.$transaction(async (tx) => {
      await tx.sysRolePermission.deleteMany({ where: { roleId } });
      if (permissionIds.length > 0) {
        await tx.sysRolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
        });
      }
      await tx.sysRoleMenu.deleteMany({ where: { roleId } });
      if (menuIds.length > 0) {
        await tx.sysRoleMenu.createMany({
          data: menuIds.map((menuId) => ({ roleId, menuId })),
        });
      }
    });

    const after = await this.requireDetailRow(roleId);
    await this.cache.forRole(roleId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:role',
      action: 'assign_permission',
      resourceType: 'role',
      resourceId: roleId.toString(),
      resourceName: after.name,
      detail: {
        permissions: buildSetDiff(permissionCodesOf(before), permissionCodesOf(after)),
        menus: buildSetDiff(menuIdsOf(before), menuIdsOf(after)),
      },
    });
    return this.buildDetail(after);
  }

  // ---------------------------------------------------------------------------
  // 内部：取数与校验
  // ---------------------------------------------------------------------------

  /** detail 响应里的 userCount：与列表同口径，只数未软删的用户。 */
  private async buildDetail(row: RoleDetailRow): Promise<RoleDetail> {
    const userCount = await this.db.sysUserRole.count({
      where: { roleId: row.id, user: { deletedAt: null } },
    });
    return toRoleDetail(row, userCount);
  }

  private async requireRow(id: bigint): Promise<RoleRow> {
    const row = await this.db.sysRole.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw new BusinessException('角色不存在', ERROR_CODES.ROLE_NOT_FOUND, 404);
    }
    return row;
  }

  private async requireDetailRow(id: bigint): Promise<RoleDetailRow> {
    const row = await this.db.sysRole.findFirst({
      where: { id, deletedAt: null },
      include: ROLE_DETAIL_INCLUDE,
    });
    if (!row) {
      throw new BusinessException('角色不存在', ERROR_CODES.ROLE_NOT_FOUND, 404);
    }
    return row;
  }

  /** code 占用判定只看未删除的行（与条件唯一索引 uk_sys_role_code 同口径）。 */
  private async assertCodeFree(code: string, excludeId: bigint | null): Promise<void> {
    const conflict = await this.db.sysRole.findFirst({
      where: { deletedAt: null, code, ...(excludeId === null ? {} : { id: { not: excludeId } }) },
      select: { id: true },
    });
    if (conflict) {
      throw new BusinessException(
        `角色标识「${code}」已存在，请换一个`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
  }

  /** 权限码 → sys_permission.id；常量里有但字典表缺行说明 seed 没跑齐，明确报错而不是 FK 炸 500。 */
  private async resolvePermissionIds(codes: readonly string[]): Promise<bigint[]> {
    if (codes.length === 0) {
      return [];
    }
    const rows = await this.db.sysPermission.findMany({
      where: { code: { in: [...codes] } },
      select: { id: true, code: true },
    });
    if (rows.length !== codes.length) {
      const found = new Set(rows.map((row) => row.code));
      throw new BusinessException(
        `以下权限码未同步进字典表（请先执行 seed）：${codes.filter((code) => !found.has(code)).join('、')}`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    return rows.map((row) => row.id);
  }

  /** 菜单 id 必须存在（sys_menu 无软删除列，见数据库设计 §4.1.6）；缺一个就整体拒绝，覆盖式写入不静默丢。 */
  private async resolveMenuIds(menuIds: readonly string[]): Promise<bigint[]> {
    if (menuIds.length === 0) {
      return [];
    }
    const ids = menuIds.map((menuId) => parseIdParam(menuId, '菜单 id'));
    const rows = await this.db.sysMenu.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (rows.length !== new Set(ids.map((id) => id.toString())).size) {
      const found = new Set(rows.map((row) => row.id.toString()));
      const missing = ids.filter((id) => !found.has(id.toString()));
      throw new BusinessException(
        `菜单不存在：${missing.map((id) => id.toString()).join('、')}`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    return ids;
  }
}

// -----------------------------------------------------------------------------
// 映射（纯函数，导出给单测直接断言）
// -----------------------------------------------------------------------------

export function permissionCodesOf(row: RoleDetailRow): string[] {
  return row.rolePermissions.map((link) => link.permission.code);
}

export function menuIdsOf(row: RoleDetailRow): string[] {
  return row.roleMenus.map((link) => link.menuId.toString());
}

export function toRoleListItem(row: RoleRow, userCount: number): RoleListItem {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    dataScope: toDataScope(row.dataScope),
    builtIn: row.builtIn,
    sort: row.sort,
    status: row.status === 0 ? 0 : 1,
    remark: row.remark,
    userCount,
  };
}

export function toRoleDetail(row: RoleDetailRow, userCount: number): RoleDetail {
  return {
    ...toRoleListItem(row, userCount),
    // 字典表里可能存在已从 PERMISSIONS 移除的历史码；对外契约只回认得的码。
    permissionCodes: permissionCodesOf(row).filter(isPermissionCode) as PermissionCode[],
    menuIds: menuIdsOf(row),
  };
}

/** 可进审计的角色字段白名单。 */
export function pickRoleAuditedFields(row: RoleRow): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    dataScope: row.dataScope,
    builtIn: row.builtIn,
    sort: row.sort,
    status: row.status,
    remark: row.remark,
  };
}

/** P2002（并发下 create 撞唯一索引）翻译成人话 400，而不是让 Prisma 原始错误炸成 500。 */
function uniqueCodeConflict(error: unknown): unknown {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'P2002'
  ) {
    return new BusinessException(
      '角色标识已存在（可能是并发创建冲突），请重试',
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  return error;
}

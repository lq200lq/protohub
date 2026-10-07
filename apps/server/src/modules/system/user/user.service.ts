import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { argon2id, hash, verify } from 'argon2';
import {
  BUILT_IN_ROLE_CODES,
  ERROR_CODES,
  type AssignUserRolesParams,
  type CreateUserResult,
  type ResetUserPasswordResult,
  type RoleRef,
  type UserDetail,
  type UserListItem,
  type UserStatus,
} from '@protohub/shared';

import {
  BusinessException,
  ForbiddenBusinessException,
} from '../../../common/exception/business.exception';
import {
  toPageData,
  type NormalizedPageQuery,
  type PageData,
} from '../../../common/pagination/pagination';
import { PRISMA_CLIENT } from '../persistence/prisma-token';
import type { Actor, RequestMeta } from '../common/actor';
import {
  buildChangeDiff,
  buildSetDiff,
  passwordChangedDetail,
  snapshotDetail,
} from '../common/audit-diff';
import { toDataScope, widestDataScope } from '../common/data-scope';
import { assertSortField, parseIdParam } from '../common/dto';
import { CacheInvalidation } from '../permission-cache/cache-invalidation.service';
import { OperationAuditWriter } from '../audit/operation-audit.writer';
import type {
  ChangePasswordInput,
  CreateUserInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserListFilterInput,
} from './user.dto';
import { checkPasswordStrength, generateInitialPassword } from './password-policy';
import {
  SUPER_ADMIN_ROLE_CODE,
  assertCanGrantSuperAdmin,
  assertNotLastSuperAdmin,
  assertNotSelfDelete,
  assertNotSelfDisable,
  assertNotSelfSuperAdminRevoke,
  isSameUser,
} from './user-rules';

/**
 * 系统管理·用户（后端接口设计 §7.1 + 权限模型设计 §4 约束 C-2/C-3/C-4）。
 *
 * 两条贯穿全文件的硬规则：
 * 1. **软删除**：`sys_user`/`sys_role` 的每条查询都带 `deletedAt: null`（计划 §8 F-6——
 *    漏一处就会让"删掉的用户又出现在列表里"，而且唯一索引 uk_sys_user_username 也是条件索引，
 *    漏过滤还会让用户名占用判定算上已删账号）。
 * 2. **审计脱敏**：明文密码只出现在返回值里一次（§7.1.2 "不写日志"），任何 detail 都经过
 *    common/audit-diff 的白名单构造，绝不把整行记录原样塞进去（行里有 password_hash）。
 */

/** 用户与其角色关联的取数形状；角色侧同样排除软删角色，否则已删角色会继续在列表里显示。 */
const USER_INCLUDE = {
  userRoles: {
    where: { role: { deletedAt: null } },
    include: { role: true },
    orderBy: { role: { sort: 'asc' } },
  },
} as const;

type UserRow = Prisma.SysUserGetPayload<{ include: typeof USER_INCLUDE }>;

const LIST_SORT_FIELDS = [
  'username',
  'realName',
  'email',
  'status',
  'createdAt',
  'updatedAt',
  'lastLoginAt',
] as const;

@Injectable()
export class UserService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    private readonly audit: OperationAuditWriter,
    private readonly cache: CacheInvalidation,
  ) {}

  /** §7.1.1 分页列表：keyword（用户名/姓名/邮箱）+ status + roleId。 */
  async list(
    filter: UserListFilterInput,
    page: NormalizedPageQuery,
  ): Promise<PageData<UserListItem>> {
    const where = this.buildListWhere(filter);
    const orderBy = this.buildListOrderBy(page);
    const [rows, total] = await Promise.all([
      this.db.sysUser.findMany({
        where,
        include: USER_INCLUDE,
        orderBy,
        skip: page.skip,
        take: page.pageSize,
      }),
      this.db.sysUser.count({ where }),
    ]);
    return toPageData(rows.map(toUserListItem), total);
  }

  /** §7.1.3 详情（含角色 + 该用户最宽数据范围，C-6）。 */
  async detail(id: string): Promise<UserDetail> {
    return toUserDetail(await this.requireRow(parseIdParam(id, '用户 id')));
  }

  /**
   * §7.1.2 新建用户：密码由服务端随机生成、只在响应里出现一次。
   * 不接受调用方传密码（DTO 里 password 字段被显式拒绝）——否则管理员可以给别人设弱密码，
   * 而强度校验（§2.8）就形同虚设。
   */
  async create(
    actor: Actor,
    input: CreateUserInput,
    request: RequestMeta,
  ): Promise<CreateUserResult> {
    await this.assertUsernameFree(input.username);
    const roles = await this.resolveRoles(input.roleIds);
    assertCanGrantSuperAdmin(actor, roles.some((role) => role.code === SUPER_ADMIN_ROLE_CODE));

    const initialPassword = generateInitialPassword();
    // 强度是生成器的不变量，仍然断言一次：字符集或长度哪天被改小时，这里会立刻失败而不是发出弱口令账号。
    const strength = checkPasswordStrength(initialPassword);
    if (!strength.valid) {
      throw new BusinessException(
        '初始密码生成异常（强度不达标），请联系运维',
        ERROR_CODES.INTERNAL_ERROR,
        500,
      );
    }
    const passwordHash = await hash(initialPassword, { type: argon2id });

    const createdId = await this.db.$transaction(async (tx) => {
      const user = await tx.sysUser.create({
        data: {
          username: input.username,
          passwordHash,
          realName: input.realName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          status: 1,
          // 首登必须改密（数据库设计 §6.4：初始密码只展示一次，不能长期当凭据用）。
          forcePasswordChange: true,
          remark: input.remark ?? null,
          createdBy: parseActorId(actor.userId),
        },
      });
      if (roles.length > 0) {
        await tx.sysUserRole.createMany({
          data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
        });
      }
      return user.id;
    });

    const row = await this.requireRow(createdId);
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'create',
      resourceType: 'user',
      resourceId: createdId.toString(),
      resourceName: row.username,
      // 初始密码**不进** detail（§7.1.2 明文要求）；只记这次创建暴露给管理员的非敏感字段。
      detail: {
        before: null,
        after: {
          username: row.username,
          realName: row.realName,
          status: row.status,
          roleCodes: roles.map((role) => role.code).sort(),
          forcePasswordChange: true,
          initialPasswordGenerated: true,
        },
      },
    });

    return { ...toUserListItem(row), initialPassword };
  }

  /** §7.1.4 编辑；username 不可改（DTO 层已拒），status=0 时 C-2/C-3 生效。 */
  async update(
    actor: Actor,
    id: string,
    input: UpdateUserInput,
    request: RequestMeta,
  ): Promise<UserDetail> {
    const userId = parseIdParam(id, '用户 id');
    const before = await this.requireRow(userId);
    const nextStatus = toStatusNumber(input.status);

    if (before.status === 1 && nextStatus === 0) {
      await this.assertNotDisableAllowed(actor, before);
    }

    await this.db.sysUser.update({
      where: { id: userId },
      data: {
        realName: input.realName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        status: nextStatus,
        remark: input.remark ?? null,
        // schema 的 updated_at 没有 @updatedAt（数据库设计 §4.1.1 只给了 DEFAULT now()），
        // 不显式写就会让"按更新时间排序"永远停在创建那一刻。
        updatedAt: new Date(),
        updatedBy: parseActorId(actor.userId),
      },
    });

    const after = await this.requireRow(userId);
    if (nextStatus !== before.status) {
      // §8.2：禁用用户要主动失效权限码缓存（Guard 的 status 查询不缓存，但缓存里的码集也该一起清掉）。
      await this.cache.forUser(userId.toString());
    }
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'update',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: after.username,
      detail: buildChangeDiff(
        pickUserAuditedFields(before),
        pickUserAuditedFields(after),
      ),
    });
    return toUserDetail(after);
  }

  /** 启停（§7.1.4 的 status 动作化：界面开关直接调它，避免整表单回传带来的覆盖风险）。 */
  async setStatus(
    actor: Actor,
    id: string,
    status: UserStatus,
    request: RequestMeta,
  ): Promise<UserDetail> {
    return this.update(
      actor,
      id,
      { ...(await this.toUpdateParams(id)), status },
      request,
    );
  }

  /** §7.1.6 重置为随机密码并返回一次；token_version+1（其它设备立即失效）、首登强制改密。 */
  async resetPassword(
    actor: Actor,
    id: string,
    request: RequestMeta,
  ): Promise<ResetUserPasswordResult> {
    const userId = parseIdParam(id, '用户 id');
    const row = await this.requireRow(userId);
    const newPassword = generateInitialPassword();

    await this.db.sysUser.update({
      where: { id: userId },
      data: {
        passwordHash: await hash(newPassword, { type: argon2id }),
        // 权限模型 §5.4：管理员重置他人密码 → 该用户全部在线会话失效。
        tokenVersion: { increment: 1 },
        forcePasswordChange: true,
        updatedAt: new Date(),
        updatedBy: parseActorId(actor.userId),
      },
    });

    await this.cache.forUser(userId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'reset_password',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: row.username,
      // §4.1.9 硬约束：密码类变更只记 {"password_changed": true}。
      detail: passwordChangedDetail(),
    });
    return { newPassword };
  }

  /** §7.1.7 覆盖式分配角色；C-4（谁能授超管）与 C-3（不能撤自己的超管）在这里生效。 */
  async assignRoles(
    actor: Actor,
    id: string,
    input: AssignUserRolesParams,
    request: RequestMeta,
  ): Promise<UserDetail> {
    const userId = parseIdParam(id, '用户 id');
    const before = await this.requireRow(userId);
    const roles = await this.resolveRoles(input.roleIds);
    const grantsSuperAdmin = roles.some(
      (role) => role.code === SUPER_ADMIN_ROLE_CODE,
    );
    assertCanGrantSuperAdmin(actor, grantsSuperAdmin);
    assertNotSelfSuperAdminRevoke({
      targetIsSelf: isSameUser(actor, userId.toString()),
      actorIsSuperAdmin: actor.isSuperAdmin,
      keepsSuperAdmin: grantsSuperAdmin,
    });

    // C-2：撤销别人的超管身份也可能让平台只剩一个超管，这里只挡"撤掉后一个都不剩"的极端情形。
    const beforeCodes = roleCodesOf(before);
    if (beforeCodes.includes(SUPER_ADMIN_ROLE_CODE) && !grantsSuperAdmin) {
      await this.assertSuperAdminSurvives(userId, 'disable');
    }

    const after = await this.db.$transaction(async (tx) => {
      await tx.sysUserRole.deleteMany({ where: { userId } });
      if (roles.length > 0) {
        await tx.sysUserRole.createMany({
          data: roles.map((role) => ({ userId, roleId: role.id })),
        });
      }
      return tx.sysUser.findUniqueOrThrow({ where: { id: userId }, include: USER_INCLUDE });
    });

    // §8.2 明确要求"改用户角色"主动失效该用户的权限码缓存。
    await this.cache.forUser(userId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'assign_role',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: after.username,
      detail: buildSetDiff(beforeCodes, roleCodesOf(after)),
    });
    return toUserDetail(after);
  }

  /** §7.1.5 软删除；C-2/C-3 生效。 */
  async remove(actor: Actor, id: string, request: RequestMeta): Promise<{ id: string }> {
    const userId = parseIdParam(id, '用户 id');
    const row = await this.requireRow(userId);
    assertNotSelfDelete(actor, userId.toString());

    const codes = roleCodesOf(row);
    if (codes.includes(SUPER_ADMIN_ROLE_CODE)) {
      await this.assertSuperAdminSurvives(userId, 'delete');
    }

    await this.db.sysUser.update({
      where: { id: userId },
      data: { deletedAt: new Date(), updatedAt: new Date(), updatedBy: parseActorId(actor.userId) },
    });
    await this.cache.forUser(userId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'delete',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: row.username,
      // 删完就查不到原值了，快照必须在删除前取（同样只取可审计字段）。
      detail: snapshotDetail(pickUserAuditedFields(row)),
    });
    return { id: userId.toString() };
  }

  /** §2.7 本人改资料（只允许 realName/email/phone/avatar；username/status/roleIds 由 DTO 拒绝）。 */
  async updateProfile(
    actor: Actor,
    input: UpdateProfileInput,
    request: RequestMeta,
  ): Promise<UserDetail> {
    const userId = parseActorId(actor.userId);
    const before = await this.requireRow(userId);
    await this.db.sysUser.update({
      where: { id: userId },
      data: {
        realName: input.realName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        avatar: input.avatar ?? null,
        updatedAt: new Date(),
        updatedBy: userId,
      },
    });
    const after = await this.requireRow(userId);
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'update',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: after.username,
      detail: buildChangeDiff(
        pickUserAuditedFields(before),
        pickUserAuditedFields(after),
      ),
    });
    return toUserDetail(after);
  }

  /** §2.8 本人改密码：强度校验 + token_version+1 + 清 force_password_change。 */
  async changePassword(
    actor: Actor,
    input: ChangePasswordInput,
    request: RequestMeta,
  ): Promise<null> {
    const userId = parseActorId(actor.userId);
    const row = await this.db.sysUser.findFirst({
      // 注意：这里要读 passwordHash，所以只取需要的列，绝不把整行往外传（审计与返回值都不含它）。
      where: { id: userId, deletedAt: null },
      select: { id: true, username: true, passwordHash: true },
    });
    if (!row) {
      throw new BusinessException(
        '账号不存在或已删除',
        ERROR_CODES.USER_NOT_FOUND,
        404,
      );
    }

    if (!(await verify(row.passwordHash, input.oldPassword))) {
      throw new BusinessException(
        '当前密码不正确',
        ERROR_CODES.USER_OLD_PASSWORD_INVALID,
        400,
      );
    }
    const strength = checkPasswordStrength(input.newPassword);
    if (!strength.valid) {
      throw new BusinessException(
        strength.reason ?? '密码强度不足',
        ERROR_CODES.USER_PASSWORD_INVALID,
        400,
      );
    }
    if (input.newPassword === input.oldPassword) {
      throw new BusinessException(
        '新密码不能与当前密码相同',
        ERROR_CODES.USER_PASSWORD_INVALID,
        400,
      );
    }

    await this.db.sysUser.update({
      where: { id: userId },
      data: {
        passwordHash: await hash(input.newPassword, { type: argon2id }),
        // §5.4：改自己的密码 → 其它设备的 accessToken 与 proto_sess 全部失效。
        tokenVersion: { increment: 1 },
        // 首登强制改密的标记到此完成使命（§2.8）。
        forcePasswordChange: false,
        updatedAt: new Date(),
        updatedBy: userId,
      },
    });
    await this.cache.forUser(userId.toString());
    await this.audit.record({
      actor,
      request,
      module: 'system:user',
      action: 'change_password',
      resourceType: 'user',
      resourceId: userId.toString(),
      resourceName: row.username,
      detail: passwordChangedDetail(),
    });
    return null;
  }

  // ---------------------------------------------------------------------------
  // 内部：取数与校验
  // ---------------------------------------------------------------------------

  /** 本人视角的详情（GET /user/profile）：Guard 已保证 actor 是启用且未删的账号。 */
  async profileOf(actor: Actor): Promise<UserDetail> {
    return toUserDetail(await this.requireRow(parseActorId(actor.userId)));
  }

  private async toUpdateParams(id: string): Promise<UpdateUserInput> {
    const row = await this.requireRow(parseIdParam(id, '用户 id'));
    return {
      realName: row.realName,
      email: row.email,
      phone: row.phone,
      status: toUserStatus(row.status),
      remark: row.remark,
    };
  }

  private async requireRow(id: bigint): Promise<UserRow> {
    const row = await this.db.sysUser.findFirst({ where: { id, deletedAt: null }, include: USER_INCLUDE });
    if (!row) {
      throw new BusinessException('用户不存在', ERROR_CODES.USER_NOT_FOUND, 404);
    }
    return row;
  }

  /** 角色 id → 角色行；任何不存在/已软删的 id 都整体拒绝（覆盖式写入不该静默丢掉一半角色）。 */
  private async resolveRoles(
    roleIds: readonly string[],
  ): Promise<readonly { id: bigint; code: string; name: string }[]> {
    if (roleIds.length === 0) {
      return [];
    }
    const ids = roleIds.map((id) => parseIdParam(id, '角色 id'));
    const rows = await this.db.sysRole.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { sort: 'asc' },
    });
    if (rows.length !== new Set(ids.map((id) => id.toString())).size) {
      const found = new Set(rows.map((role) => role.id.toString()));
      const missing = ids.filter((id) => !found.has(id.toString()));
      throw new BusinessException(
        `角色不存在或已删除：${missing.map((id) => id.toString()).join('、')}`,
        ERROR_CODES.ROLE_NOT_FOUND,
        400,
      );
    }
    return rows;
  }

  /**
   * 用户名占用判定：`lower(username)` 上的条件唯一索引（数据库设计 §4.1.1）意味着
   * 必须大小写不敏感比较，并且**已软删账号不占用名字**（否则删掉的账号永远占着用户名）。
   */
  private async assertUsernameFree(username: string): Promise<void> {
    const conflict = await this.db.sysUser.findFirst({
      where: {
        deletedAt: null,
        username: { equals: username, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (conflict) {
      throw new BusinessException(
        `用户名「${username}」已被占用，请换一个`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
  }

  /**
   * C-2 的实现口径：数"除了目标以外还剩几个可用超管"，为 0 才拦。
   * delete 场景只要求未软删；disable 场景还要目标是启用态——禁用中的账号本来就不是管理入口。
   */
  private async assertSuperAdminSurvives(
    targetUserId: bigint,
    action: 'delete' | 'disable',
  ): Promise<void> {
    const remaining = await this.countSuperAdmins({
      excludeUserId: targetUserId,
      onlyEnabled: action === 'disable',
    });
    assertNotLastSuperAdmin({
      targetIsSuperAdmin: true,
      activeSuperAdminCount: remaining + 1,
      action,
    });
  }

  private async countSuperAdmins(input: {
    readonly excludeUserId: bigint;
    readonly onlyEnabled: boolean;
  }): Promise<number> {
    return this.db.sysUser.count({
      where: {
        deletedAt: null,
        status: input.onlyEnabled ? 1 : undefined,
        id: { not: input.excludeUserId },
        userRoles: {
          some: {
            role: { code: SUPER_ADMIN_ROLE_CODE, deletedAt: null, status: 1 },
          },
        },
      },
    });
  }

  /** 停用前的三条护栏（C-3 自锁 + C-2 最后一个超管）。 */
  private async assertNotDisableAllowed(actor: Actor, row: UserRow): Promise<void> {
    assertNotSelfDisable(actor, row.id.toString());
    if (roleCodesOf(row).includes(SUPER_ADMIN_ROLE_CODE)) {
      await this.assertSuperAdminSurvives(row.id, 'disable');
    }
  }

  private buildListWhere(filter: UserListFilterInput): Prisma.SysUserWhereInput {
    const keyword = filter.keyword?.trim();
    const where: Prisma.SysUserWhereInput = { deletedAt: null };
    // status 为 0 时是合法筛选值，不能用 `if (filter.status)` 判真值（0 会被当成"没填"）。
    if (filter.status !== undefined) {
      where.status = filter.status;
    }
    if (filter.roleId !== undefined) {
      where.userRoles = {
        some: { roleId: BigInt(filter.roleId), role: { deletedAt: null } },
      };
    }
    if (keyword !== undefined && keyword !== '') {
      where.OR = [
        { username: { contains: keyword, mode: 'insensitive' } },
        { realName: { contains: keyword, mode: 'insensitive' } },
        { email: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** 排序字段白名单（§1.3）：不认识的字段报 400，绝不拼进 orderBy——那里没有参数化保护。 */
  private buildListOrderBy(
    page: NormalizedPageQuery,
  ): Prisma.SysUserOrderByWithRelationInput {
    const direction = page.sortOrder ?? 'desc';
    switch (assertSortField(page.sortBy, LIST_SORT_FIELDS, 'createdAt')) {
      case 'username':
        return { username: direction };
      case 'realName':
        return { realName: direction };
      case 'email':
        return { email: direction };
      case 'status':
        return { status: direction };
      case 'updatedAt':
        return { updatedAt: direction };
      case 'lastLoginAt':
        return { lastLoginAt: direction };
      default:
        return { createdAt: direction };
    }
  }
}

// -----------------------------------------------------------------------------
// 映射（纯函数，单独导出给单测直接断言）
// -----------------------------------------------------------------------------

export function roleRefsOf(row: UserRow): RoleRef[] {
  return row.userRoles.map((link) => ({
    id: link.role.id.toString(),
    code: link.role.code,
    name: link.role.name,
  }));
}

export function roleCodesOf(row: UserRow): string[] {
  return roleRefsOf(row).map((role) => role.code);
}

/**
 * `builtIn`：sys_user 表没有这个列（数据库设计 §4.1.1 未定义），这里按"持有内置角色即视为内置账号"
 * 派生——C-2 的保护对象正是超管，界面据此把删除/禁用按钮置灰。
 * 若将来要区分"内置账号"与"后来补授超管的账号"，需要给 sys_user 加 built_in 列（已记交付报告）。
 */
export function isBuiltInAccount(row: UserRow): boolean {
  return roleCodesOf(row).some((code: string) =>
    (BUILT_IN_ROLE_CODES as readonly string[]).includes(code),
  );
}

export function toUserListItem(row: UserRow): UserListItem {
  return {
    id: row.id.toString(),
    username: row.username,
    realName: row.realName,
    email: row.email,
    phone: row.phone,
    avatar: row.avatar,
    status: toUserStatus(row.status),
    roles: roleRefsOf(row),
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    lastLoginIp: row.lastLoginIp,
    createdAt: row.createdAt.toISOString(),
    builtIn: isBuiltInAccount(row),
  };
}

export function toUserDetail(row: UserRow): UserDetail {
  const roles = row.userRoles.map((link) => toDataScope(link.role.dataScope));
  return {
    ...toUserListItem(row),
    // C-6：多角色取最宽。
    dataScope: widestDataScope(roles),
    remark: row.remark,
  };
}

/** 可进审计日志的用户字段白名单——写死名单，新增列时不会因为顺手带上 password_hash 而泄露。 */
export function pickUserAuditedFields(
  row: UserRow,
): Record<string, unknown> {
  return {
    username: row.username,
    realName: row.realName,
    email: row.email,
    phone: row.phone,
    status: row.status,
    remark: row.remark,
    roleCodes: roleCodesOf(row).sort(),
  };
}

export function toUserStatus(value: number): UserStatus {
  return value === 0 ? 0 : 1;
}

function toStatusNumber(value: number): number {
  return value === 0 ? 0 : 1;
}

function parseActorId(userId: string): bigint {
  try {
    return parseIdParam(userId, '操作者 id');
  } catch {
    throw new ForbiddenBusinessException(
      '登录状态异常，请重新登录',
      ERROR_CODES.AUTH_TOKEN_INVALID,
    );
  }
}

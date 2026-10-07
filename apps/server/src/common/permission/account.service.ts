import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import { DATA_SCOPES, type DataScope } from '@protohub/shared';

import type { AuthUser } from './auth-user';
import { PRISMA_CLIENT } from './prisma-client';

/** 内置超管角色标识（权限模型设计 §4，约束 C-5 依赖它做短路）。 */
export const SUPER_ADMIN_ROLE = 'super_admin';

export interface AccountRole {
  readonly code: string;
  readonly name: string;
  readonly dataScope: DataScope;
}

export interface Account {
  readonly userId: string;
  readonly username: string;
  readonly realName: string;
  readonly avatar: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** 1 启用 / 0 禁用。 */
  readonly status: number;
  readonly tokenVersion: number;
  readonly forcePasswordChange: boolean;
  /** 只含启用状态的角色：停用角色不应继续给用户供权限。 */
  readonly roles: readonly AccountRole[];
  readonly dataScope: DataScope;
  readonly superAdmin: boolean;
}

/** Prisma 查询结果里我们消费的那些字段（结构化声明，避免把生成类型泄漏到签名上）。 */
interface SysUserRow {
  readonly id: bigint;
  readonly username: string;
  readonly realName: string;
  readonly avatar: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: number;
  readonly tokenVersion: number;
  readonly forcePasswordChange: boolean;
  readonly userRoles: readonly { readonly role: { readonly code: string; readonly name: string; readonly dataScope: string; readonly sort: number } }[];
}

/** 数据范围宽窄：多角色取最宽（约束 C-6）。 */
const SCOPE_WIDTH: Record<DataScope, number> = { all: 3, member: 2, own: 1 };

const NARROWEST_SCOPE: DataScope = 'own';

function toDataScope(value: string): DataScope {
  return (DATA_SCOPES as readonly string[]).includes(value)
    ? (value as DataScope)
    : NARROWEST_SCOPE;
}

export function widestDataScope(scopes: readonly DataScope[]): DataScope {
  return scopes.reduce<DataScope>(
    (widest, scope) => (SCOPE_WIDTH[scope] > SCOPE_WIDTH[widest] ? scope : widest),
    NARROWEST_SCOPE,
  );
}

function toId(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

/** 只取启用角色的关联：`status=0` 的角色既不给权限码，也不给数据范围。 */
const accountInclude = {
  userRoles: {
    where: { role: { deletedAt: null, status: 1 } },
    include: { role: { select: { code: true, name: true, dataScope: true, sort: true } } },
    orderBy: { role: { sort: 'asc' } },
  },
} as const;

function mapAccount(row: SysUserRow): Account {
  const roles: AccountRole[] = row.userRoles.map((link) => ({
    code: link.role.code,
    name: link.role.name,
    dataScope: toDataScope(link.role.dataScope),
  }));
  return {
    userId: row.id.toString(),
    username: row.username,
    realName: row.realName,
    avatar: row.avatar,
    email: row.email,
    phone: row.phone,
    status: row.status,
    tokenVersion: row.tokenVersion,
    forcePasswordChange: row.forcePasswordChange,
    roles,
    dataScope: widestDataScope(roles.map((role) => role.dataScope)),
    superAdmin: roles.some((role) => role.code === SUPER_ADMIN_ROLE),
  };
}

function primaryRoleName(roles: readonly AccountRole[]): string | null {
  const widest = roles.reduce<AccountRole | undefined>(
    (best, role) =>
      best === undefined || SCOPE_WIDTH[role.dataScope] > SCOPE_WIDTH[best.dataScope]
        ? role
        : best,
    undefined,
  );
  return widest?.name ?? null;
}

/**
 * 登录态的**不缓存**读取。
 *
 * 权限模型设计 §8.2：权限码可以缓存 30 秒，但 `status` 与 `token_version` 这类"撤销类"
 * 判断必须每次查库，否则禁用用户/改密不会即时生效（Gate M1 的 G7）。
 * 因此这里只查"身份 + 角色"，权限码交给 PermissionCodeService 缓存。
 */
@Injectable()
export class AccountService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  async loadById(userId: string): Promise<Account | null> {
    const id = toId(userId);
    if (id === null) {
      return null;
    }
    const row = await this.db.sysUser.findUnique({
      where: { id, deletedAt: null },
      include: accountInclude,
    });
    return row ? mapAccount(row) : null;
  }

  /** 登录用：用户名唯一索引建在 `lower(username)` 上，所以按大小写不敏感查。 */
  async loadByUsername(username: string): Promise<Account | null> {
    const row = await this.db.sysUser.findFirst({
      where: { deletedAt: null, username: { equals: username, mode: 'insensitive' } },
      include: accountInclude,
    });
    return row ? mapAccount(row) : null;
  }

  toAuthUser(account: Account): AuthUser {
    return {
      userId: account.userId,
      username: account.username,
      realName: account.realName,
      avatar: account.avatar,
      email: account.email,
      phone: account.phone,
      roles: account.roles.map((role) => role.code),
      primaryRoleName: primaryRoleName(account.roles),
      dataScope: account.dataScope,
      forcePasswordChange: account.forcePasswordChange,
      tokenVersion: account.tokenVersion,
    };
  }
}

/**
 * 首个超级管理员（数据库设计 §6.4 + 权限模型 §8.3-5 + 迭代实施计划 M1-T4/T9）。
 *
 * 幂等语义：库里已存在任何未删除的 super_admin 用户 → 直接跳过（不新建、
 * 更不改任何人已有的密码/状态）；否则创建 username（默认 admin）、argon2id
 * 随机密码（只在返回值里出现一次，由入口打印，绝不入库/入日志）、
 * forcePasswordChange=true（M1-T9 首登强制改密依赖它）。
 */
import type { Prisma } from '@prisma/client';
import { generateInitialPassword, hashPassword } from './password';

export const DEFAULT_SUPER_ADMIN_USERNAME = 'admin';

export interface CreatedSuperAdmin {
  userId: bigint;
  username: string;
  /** 明文只存在于返回值→stdout 这一段；任何写库/日志路径都不碰它 */
  password: string;
}

export interface EnsureSuperAdminOptions {
  username?: string;
  realName?: string;
}

export async function ensureFirstSuperAdmin(
  db: Prisma.TransactionClient,
  options: EnsureSuperAdminOptions = {},
): Promise<CreatedSuperAdmin | null> {
  const username = options.username ?? DEFAULT_SUPER_ADMIN_USERNAME;

  const superAdminRole = await db.sysRole.findFirst({
    where: { code: 'super_admin', deletedAt: null },
  });
  if (!superAdminRole) {
    throw new Error('[seed/admin] super_admin 角色不存在——先跑 seed.ts（角色由主 seed 建立）');
  }

  // "不存在任何 super_admin 用户"才创建（M1-T4 判据）；查到的既有超管一律不动
  const existing = await db.sysUser.findFirst({
    where: {
      deletedAt: null,
      userRoles: { some: { role: { code: 'super_admin', deletedAt: null } } },
    },
  });
  if (existing) {
    return null;
  }
  const taken = await db.sysUser.findFirst({ where: { username, deletedAt: null } });
  if (taken) {
    throw new Error(
      `[seed/admin] 用户名 "${username}" 已被非 super_admin 占用，请用 --username 换一个`,
    );
  }

  const password = generateInitialPassword();
  const passwordHash = await hashPassword(password);

  const user = await db.sysUser.create({
    data: {
      username,
      passwordHash,
      realName: options.realName ?? '超级管理员',
      // 首登强制改密（迭代实施计划 M1-T9：登录后路由守卫拦截）
      forcePasswordChange: true,
      remark: '由 seed-admin 创建',
      userRoles: { create: { roleId: superAdminRole.id } },
    },
  });

  // §6.4 审计约定：seed 留一条登录日志痕迹（只记用户名，不含任何口令信息）
  await db.sysLoginLog.create({
    data: {
      userId: user.id,
      username: user.username,
      loginType: 'login',
      success: false,
      failReason: 'initial seed',
    },
  });

  return { userId: user.id, username: user.username, password };
}

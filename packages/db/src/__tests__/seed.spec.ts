/**
 * seed 集成测试（迭代实施计划 §3.6：必须跑在 protohub_test 上）。
 *
 * 前置：`pnpm db:migrate` 已把迁移应用到 protohub_test（本套件不清 schema，
 * 只清 sys_ 种子相关表，保证自身可重复运行）。
 * 护栏：开头自检目标库必须是 *_test，不是就直接抛错拒跑（连断言都不做）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { PERMISSIONS, PERMISSION_CODES } from '@protohub/shared';
import { createPrismaClient } from '../index';
// 显式 /index：'../seed' 会命中带副作用的入口 src/seed.ts
import { runSeed, ensureFirstSuperAdmin } from '../seed/index';
import { assertTestDatabase, databaseNameOf } from '../seed/guard';
import { permissionCodesFor } from '../seed/roles';

// 优先级：TEST_DATABASE_URL → DATABASE_URL（若它本就指向 _test）→ 文档约定缺省值。
// 无论取哪一个，assertTestDatabase 保证最终连的库名以 _test 结尾，否则拒绝运行。
const targetUrl = (() => {
  const candidate =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL && databaseNameOf(process.env.DATABASE_URL).endsWith('_test')
      ? process.env.DATABASE_URL
      : undefined) ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub_test?schema=public';
  assertTestDatabase(candidate);
  return candidate;
})();

let prisma: PrismaClient;

/** 种子触及的全部表计数（外加 sys_user_role / sys_login_log 两张关联表）。 */
async function snapshotCounts() {
  const [
    permissions,
    roles,
    rolePermissions,
    menus,
    roleMenus,
    users,
    userRoles,
    loginLogs,
  ] = await Promise.all([
    prisma.sysPermission.count(),
    prisma.sysRole.count(),
    prisma.sysRolePermission.count(),
    prisma.sysMenu.count(),
    prisma.sysRoleMenu.count(),
    prisma.sysUser.count(),
    prisma.sysUserRole.count(),
    prisma.sysLoginLog.count(),
  ]);
  return { permissions, roles, rolePermissions, menus, roleMenus, users, userRoles, loginLogs };
}

async function seedOnce() {
  return prisma.$transaction((tx) => runSeed(tx), { timeout: 30_000, maxWait: 10_000 });
}

/** 清空种子相关表（子→父顺序，避开 sys_menu 自引用 on delete restrict）。 */
async function clearSeedTables() {
  await prisma.sysRolePermission.deleteMany();
  await prisma.sysRoleMenu.deleteMany();
  await prisma.sysUserRole.deleteMany();
  await prisma.sysLoginLog.deleteMany();
  await prisma.sysMenu.deleteMany({ where: { type: 'button' } });
  await prisma.sysMenu.deleteMany({ where: { type: { not: 'button' } } });
  await prisma.sysPermission.deleteMany();
  await prisma.sysRole.deleteMany();
  await prisma.sysUser.deleteMany();
}

beforeAll(async () => {
  prisma = createPrismaClient(targetUrl);
  await clearSeedTables();
  await seedOnce(); // 基线：后续用例都站在"已种过一次"的状态上
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('db:seed 幂等性（M1-T3 / Gate G6 / F-16）', () => {
  it('连跑两次不报错、行数完全一致', async () => {
    const before = await snapshotCounts();
    const second = await seedOnce();
    const after = await snapshotCounts();
    expect(after).toEqual(before);
    // 第二次跑应当"无事可做"：没有任何新增动作
    expect(second.menusInserted).toBe(0);
    expect(second.rolePermissionsAdded).toBe(0);
    expect(second.roleMenusAdded).toBe(0);
    expect(second.superAdmin).toBeNull();
  });

  it('内置角色恰好 4 个，built_in=true，data_scope 按权限模型 §4/§6', async () => {
    const roles = await prisma.sysRole.findMany({ orderBy: { sort: 'asc' } });
    expect(roles.map((r) => r.code)).toEqual(['super_admin', 'admin', 'publisher', 'viewer']);
    expect(roles.every((r) => r.builtIn)).toBe(true);
    expect(roles.map((r) => r.dataScope)).toEqual(['all', 'all', 'member', 'member']);
  });

  it('每个 menu 节点的 auth_code 都在 PERMISSIONS 里', async () => {
    const authCodes = (
      await prisma.sysMenu.findMany({
        where: { authCode: { not: null } },
        select: { authCode: true },
      })
    ).map((m) => m.authCode as string);
    expect(authCodes.length).toBeGreaterThan(0);
    for (const code of authCodes) {
      expect(PERMISSION_CODES).toContain(code);
    }
  });

  it('每个 PERMISSIONS 码都出现在至少一个角色授权里', async () => {
    const granted = await prisma.sysRolePermission.findMany({
      include: { permission: { select: { code: true } } },
    });
    const grantedCodes = new Set(granted.map((g) => g.permission.code));
    for (const code of PERMISSION_CODES) {
      expect(grantedCodes.has(code)).toBe(true);
    }
    // super_admin 拿全量（C-5 短路外的兜底），且与 shared 条数一致
    const superAdminPerms = await prisma.sysRolePermission.findMany({
      where: { role: { code: 'super_admin' } },
    });
    expect(superAdminPerms).toHaveLength(PERMISSIONS.length);
  });

  it('运维手工加的角色授权在重跑 seed 后保留（只增不减）', async () => {
    // viewer 按 §4 没有 system:user:list；手工补一条"seed 之外"的授权
    const extraCode = PERMISSIONS.find(
      (p) => !permissionCodesFor('viewer').includes(p.code),
    ) as (typeof PERMISSIONS)[number];
    // uk_sys_role_code 是条件唯一索引，Prisma 不识别，只能用 findFirst
    const viewer = await prisma.sysRole.findFirstOrThrow({ where: { code: 'viewer' } });
    const perm = await prisma.sysPermission.upsert({
      where: { code: extraCode.code },
      create: { code: extraCode.code, name: extraCode.name, module: extraCode.module },
      update: {},
    });
    await prisma.sysRolePermission.create({ data: { roleId: viewer.id, permissionId: perm.id } });

    await seedOnce();

    const still = await prisma.sysRolePermission.findFirst({
      where: { roleId: viewer.id, permissionId: perm.id },
    });
    expect(still).not.toBeNull();
    await prisma.sysRolePermission.delete({
      where: { roleId_permissionId: { roleId: viewer.id, permissionId: perm.id } },
    });
  });

  it('已存在的 sys_menu 行不被 seed 覆盖（菜单建归运维所有）', async () => {
    const edited = await prisma.sysMenu.update({
      where: { name: 'ProtoProject' },
      data: { title: '运维改过的标题', status: 0 },
    });
    await seedOnce();
    const after = await prisma.sysMenu.findUniqueOrThrow({ where: { name: 'ProtoProject' } });
    expect(after.title).toBe(edited.title);
    expect(after.status).toBe(0);
    await prisma.sysMenu.update({
      where: { name: 'ProtoProject' },
      data: { title: '原型项目', status: 1 },
    });
  });

  it('非 seed 创建的 sys_user 行一律不动（密码不被重置）', async () => {
    const other = await prisma.sysUser.create({
      data: {
        username: 'operator-zhang',
        passwordHash: 'not-a-real-hash',
        realName: '运维-张',
      },
    });
    await seedOnce();
    const after = await prisma.sysUser.findUniqueOrThrow({ where: { id: other.id } });
    expect(after.passwordHash).toBe('not-a-real-hash');
    expect(after.forcePasswordChange).toBe(false);
    await prisma.sysUser.delete({ where: { id: other.id } });
  });
});

describe('db:seed-admin（M1-T4）', () => {
  it('无任何 super_admin 时创建；二次执行是无声 no-op', async () => {
    // runSeed 已建过首管；清掉"seed 创建的用户"以验证创建分支
    await prisma.sysUserRole.deleteMany();
    await prisma.sysUser.deleteMany();
    await prisma.sysLoginLog.deleteMany();

    const created = await prisma.$transaction((tx) => ensureFirstSuperAdmin(tx));
    expect(created).not.toBeNull();
    expect(created!.password).toHaveLength(16);
    expect(created!.username).toBe('admin');

    // 二次执行：跳过、不新增、不返回密码
    const second = await prisma.$transaction((tx) => ensureFirstSuperAdmin(tx));
    expect(second).toBeNull();
    expect(await prisma.sysUser.count()).toBe(1);

    const admin = await prisma.sysUser.findFirstOrThrow({ where: { username: 'admin' } });
    expect(admin.forcePasswordChange).toBe(true); // 首登强制改密（M1-T9）
    expect(admin.passwordHash).not.toContain(created!.password); // 明文不入库

    // seed 留下的审计痕迹（数据库设计 §6.4），不含任何口令
    const log = await prisma.sysLoginLog.findFirst({
      where: { userId: admin.id, failReason: 'initial seed' },
    });
    expect(log).not.toBeNull();

    // §6.4 要求的 argon2id；M1-T5 后端 verify 必须用同库同默认参数
    expect(admin.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(await argon2.verify(admin.passwordHash, created!.password)).toBe(true);
    expect(await argon2.verify(admin.passwordHash, 'wrong-password')).toBe(false);

    // 角色绑定唯一：admin ↔ super_admin
    const bindings = await prisma.sysUserRole.findMany({ where: { userId: admin.id } });
    expect(bindings).toHaveLength(1);
  });
});

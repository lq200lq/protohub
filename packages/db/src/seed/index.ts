/**
 * 幂等 seed 主流程（迭代实施计划 M1-T3；顺序按数据库设计 §6：
 * 权限码 → 内置角色 → 角色权限 → 菜单树 → 角色菜单 → 首个超管）。
 *
 * 各表的幂等策略（为什么这么做，均有文档出处）：
 *  - sys_permission       upsert（权限模型 §8.3-2"冲突则更新名称与分组"）。
 *  - sys_role             4 个内置角色 upsert 名称/数据范围/built_in/sort（§6.2 SQL 的
 *                         on conflict do update 语义）；status/remark 归运维所有，不覆盖。
 *  - sys_role_permission  只增不减（§8.3-3"只增不减，避免覆盖运维手工调整"）：
 *                         补齐 §4 的应有授权，运维加的额外授权不删，运维撤掉的
 *                         seed 授权会在下次 seed 补回（seed 拥有"至少这些"的下界）。
 *  - sys_menu / sys_role_menu 缺则插入（§8.3-4 只说"插入"；菜单创建后归运维通过
 *                         菜单管理 Tab 维护（M1-T13），seed 不改已有行）。
 *  - sys_user             仅"一个 super_admin 都不存在"时创建首个超管；已有用户
 *                         （含密码、状态、角色绑定）一律不动。
 */
import type { Prisma } from '@prisma/client';
import { PERMISSIONS } from '@protohub/shared';
import { BUILT_IN_ROLES, permissionCodesFor } from './roles';
import { MENU_SEED, pageMenuNames } from './menus';
import { ensureFirstSuperAdmin, type CreatedSuperAdmin } from './admin';

export { assertTestDatabase, assertNotTestDatabase } from './guard';
export { BUILT_IN_ROLES, permissionCodesFor } from './roles';
export { MENU_SEED } from './menus';
export { ensureFirstSuperAdmin } from './admin';

export interface SeedResult {
  permissionsUpserted: number;
  roles: number;
  rolePermissionsAdded: number;
  menusInserted: number;
  menusAlreadyPresent: number;
  roleMenusAdded: number;
  superAdmin: CreatedSuperAdmin | null;
}

export async function runSeed(db: Prisma.TransactionClient): Promise<SeedResult> {
  // 1) 权限码字典：shared PERMISSIONS 是唯一来源，sort 取数组序（权限码文件注释）
  let permissionCount = 0;
  for (const [index, p] of PERMISSIONS.entries()) {
    await db.sysPermission.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, module: p.module, sort: index + 1 },
      update: { name: p.name, module: p.module, sort: index + 1, updatedAt: new Date() },
    });
    permissionCount += 1;
  }

  // 2) 内置角色（built_in=true 供 API 层强制 C-1）
  const roleByCode = new Map<string, { id: bigint }>();
  for (const role of BUILT_IN_ROLES) {
    const existing = await db.sysRole.findFirst({ where: { code: role.code, deletedAt: null } });
    if (existing) {
      const updated = await db.sysRole.update({
        where: { id: existing.id },
        // 只覆盖 seed 拥有的列；运维改过的 status（停用）与自定义 remark 不动
        data: {
          name: role.name,
          dataScope: role.dataScope,
          builtIn: true,
          sort: role.sort,
          updatedAt: new Date(),
        },
      });
      roleByCode.set(role.code, { id: updated.id });
    } else {
      const created = await db.sysRole.create({
        data: {
          code: role.code,
          name: role.name,
          dataScope: role.dataScope,
          builtIn: true,
          sort: role.sort,
          remark: role.remark,
        },
      });
      roleByCode.set(role.code, { id: created.id });
    }
  }

  // 3) 角色权限：按 §4 派生应有集合，与库中现状对齐后只补差集（只增不减）
  const permByCode = new Map(
    (await db.sysPermission.findMany({ select: { id: true, code: true } })).map((p) => [
      p.code,
      p.id,
    ]),
  );
  let rolePermsAdded = 0;
  const seedPermCodesByRole = new Map<string, Set<string>>();
  for (const role of BUILT_IN_ROLES) {
    const wanted = permissionCodesFor(role.code);
    seedPermCodesByRole.set(role.code, new Set(wanted));
    const roleId = (roleByCode.get(role.code) as { id: bigint }).id;
    const have = new Set(
      (
        await db.sysRolePermission.findMany({
          where: { roleId },
          select: { permissionId: true },
        })
      ).map((r) => r.permissionId.toString()),
    );
    const missing = wanted
      .map((code) => permByCode.get(code))
      .filter((id): id is bigint => id !== undefined && !have.has(id.toString()));
    if (missing.length > 0) {
      await db.sysRolePermission.createMany({
        data: missing.map((permissionId) => ({ roleId, permissionId })),
        skipDuplicates: true,
      });
      rolePermsAdded += missing.length;
    }
  }

  // 4) 菜单树：先页面节点、再按钮（按钮 pid 指向最近的页面节点，§6.3 注）
  const seedNames = new Set(MENU_SEED.map((n) => n.name));
  const before = await db.sysMenu.findMany({ where: { name: { in: [...seedNames] } } });
  const presentBefore = new Set(before.map((m) => m.name));
  const menuIdByName = new Map(before.map((m) => [m.name, m.id]));

  const pageNodes = MENU_SEED.filter((n) => n.type !== 'button');
  // 顶层页面先插（pid: null）；子页面要等父 id 出来才能插（二级目录：系统设置）
  const topLevelPages = pageNodes.filter((n) => n.parent === undefined);
  const childPages = pageNodes.filter((n) => n.parent !== undefined);
  await db.sysMenu.createMany({
    data: topLevelPages
      .filter((n) => !presentBefore.has(n.name))
      .map((n) => ({
        pid: null,
        type: n.type,
        name: n.name,
        title: n.title,
        path: n.path ?? null,
        component: n.component ?? null,
        authCode: n.authCode ?? null,
        icon: n.icon ?? null,
        sort: n.sort ?? 0,
        affixTab: n.affixTab ?? false,
        hideInMenu: n.hideInMenu ?? false,
      })),
    skipDuplicates: true,
  });

  // 重新取 id（首跑时 createMany 不回传 id；二跑时也要能解析出已存在页面的 id）
  const topLevelRows = await db.sysMenu.findMany({
    where: { name: { in: topLevelPages.map((n) => n.name) } },
  });
  for (const m of topLevelRows) menuIdByName.set(m.name, m.id);

  // 子页面逐条插入：父节点必须已存在（与按钮节点同一套"菜单树不完整"护栏），
  // 逐条而非 createMany 是为了兼容未来更深的层级——父可以是更浅的子页面
  for (const n of childPages) {
    if (presentBefore.has(n.name)) continue;
    const pid = n.parent ? menuIdByName.get(n.parent) : undefined;
    if (pid === undefined) {
      throw new Error(`[seed] 页面 ${n.name} 的父节点 ${n.parent} 不存在（菜单树不完整）`);
    }
    const created = await db.sysMenu.create({
      data: {
        pid,
        type: n.type,
        name: n.name,
        title: n.title,
        path: n.path ?? null,
        component: n.component ?? null,
        authCode: n.authCode ?? null,
        icon: n.icon ?? null,
        sort: n.sort ?? 0,
        affixTab: n.affixTab ?? false,
        hideInMenu: n.hideInMenu ?? false,
      },
    });
    menuIdByName.set(created.name, created.id);
  }

  // 回查全部页面 id（新建的顶层行与已存在的子页面都要进映射，按钮 pid 解析依赖它）
  const afterPages = await db.sysMenu.findMany({
    where: { name: { in: pageNodes.map((n) => n.name) } },
  });
  for (const m of afterPages) menuIdByName.set(m.name, m.id);

  const buttonNodes = MENU_SEED.filter((n) => n.type === 'button');
  const buttonRows = buttonNodes
    .filter((n) => !presentBefore.has(n.name))
    .map((n) => {
      const pid = n.parent ? menuIdByName.get(n.parent) : undefined;
      if (pid === undefined) {
        throw new Error(`[seed] 按钮 ${n.name} 的父节点 ${n.parent} 不存在（菜单树不完整）`);
      }
      return {
        pid: pid as bigint,
        type: n.type,
        name: n.name,
        title: n.title,
        authCode: n.authCode ?? null,
        sort: n.sort ?? 0,
      };
    });
  await db.sysMenu.createMany({ data: buttonRows, skipDuplicates: true });

  const afterButtons = await db.sysMenu.findMany({
    where: { name: { in: buttonNodes.map((n) => n.name) } },
  });
  for (const m of afterButtons) menuIdByName.set(m.name, m.id);
  const insertedNames = MENU_SEED.filter((n) => !presentBefore.has(n.name));
  const menusInserted = insertedNames.length;
  const menusAlreadyPresent = MENU_SEED.length - menusInserted;

  // 5) 角色菜单：页面节点全角色一致（§6.3），按钮跟随角色权限码集合（§3.7）
  let roleMenusAdded = 0;
  const pageNames = pageMenuNames();
  for (const role of BUILT_IN_ROLES) {
    const roleId = (roleByCode.get(role.code) as { id: bigint }).id;
    const allowedCodes = seedPermCodesByRole.get(role.code) as Set<string>;
    const wantedNames = new Set<string>(pageNames);
    for (const n of MENU_SEED) {
      if (n.type === 'button' && n.authCode && allowedCodes.has(n.authCode)) {
        wantedNames.add(n.name);
      }
    }
    const wantedIds = [...wantedNames]
      .map((name) => menuIdByName.get(name))
      .filter((id): id is bigint => id !== undefined);
    const have = new Set(
      (
        await db.sysRoleMenu.findMany({ where: { roleId }, select: { menuId: true } })
      ).map((r) => r.menuId.toString()),
    );
    const missing = wantedIds.filter((id) => !have.has(id.toString()));
    if (missing.length > 0) {
      await db.sysRoleMenu.createMany({
        data: missing.map((menuId) => ({ roleId, menuId })),
        skipDuplicates: true,
      });
      roleMenusAdded += missing.length;
    }
  }

  // 6) 首个超管：一个 super_admin 用户都不存在时才创建（§6.4）
  const superAdmin = await ensureFirstSuperAdmin(db);

  return {
    permissionsUpserted: permissionCount,
    roles: BUILT_IN_ROLES.length,
    rolePermissionsAdded: rolePermsAdded,
    menusInserted,
    menusAlreadyPresent,
    roleMenusAdded,
    superAdmin,
  };
}

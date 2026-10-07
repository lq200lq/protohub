/**
 * `pnpm db:migrate-menu` 入口：系统设置菜单树的一次性结构迁移（幂等，可重复跑）。
 *
 * 背景：seed 遵守"只增不改"（菜单建归运维所有，seed.spec 有守卫测试），
 * 存量库里「设置」这一行的标题/类型/组件、以及 16 个系统管理按钮的父子关系
 * 不会被 seed 纠正。本脚本只处理这棵子树：
 *   1) 存量「设置」→「系统设置」（type=catalog、component 置空）；
 *   2) 5 个子菜单缺失则按 seed 创建、已存在则对齐结构字段（pid/title/path/component/type/sort，
 *      不动 status——运维显式停用要尊重）；
 *   3) 系统管理按钮改挂最近的页面子菜单（pid 不一致才写）；
 *   4) 凡授予了系统设置的角色补授 5 个子菜单（继承入口，skipDuplicates 幂等）。
 *
 * 子菜单/按钮归属全部从 MENU_SEED 派生——seed 是唯一权威，这里不写第二份清单。
 * 新库无需本脚本：直接 `pnpm db:seed` 即可得到正确结构。
 *
 * 注意：本文件与 seed.ts 一样被 tsc -p tsconfig.build.json 编成 CJS，
 * 所以不用顶层 await / import.meta；运行走 tsx（src）或 node（dist）。
 */
import type { Prisma } from '@prisma/client';

import process from 'node:process';

import { config as loadDotenv } from 'dotenv';

import { createPrismaClient } from './index';
import { assertNotTestDatabase, redact } from './seed/guard';
import { MENU_SEED, type MenuSeedNode } from './seed/menus';

const PARENT_NAME = 'SystemSetting';

interface MigrationResult {
  buttonsReparented: number;
  childrenCreated: number;
  childrenReconciled: number;
  grantsAdded: number;
  parentUpdated: boolean;
}

async function runMigrate(tx: Prisma.TransactionClient): Promise<MigrationResult> {
  const parentSeed = MENU_SEED.find((n) => n.name === PARENT_NAME);
  const childSeeds = MENU_SEED.filter(
    (n) => n.parent === PARENT_NAME && n.type !== 'button',
  );
  if (!parentSeed || parentSeed.type !== 'catalog' || childSeeds.length === 0) {
    // 结构断言：seed 里这棵树没按约定登记时宁可失败，也不要迁移出半套结构
    throw new Error(
      `[db:migrate-menu] MENU_SEED 缺少 ${PARENT_NAME} catalog 或其子菜单，检查 seed/menus.ts`,
    );
  }

  const parent = await tx.sysMenu.findUnique({ where: { name: PARENT_NAME } });
  if (!parent) {
    // 新库（或还没跑过 seed 的库）：seed 自己会建出正确结构，无需迁移
    console.log(`[db:migrate-menu] 库里没有 ${PARENT_NAME}，无需迁移（新库直接 pnpm db:seed）`);
    return {
      buttonsReparented: 0,
      childrenCreated: 0,
      childrenReconciled: 0,
      grantsAdded: 0,
      parentUpdated: false,
    };
  }

  // 1) 存量行：设置 → 系统设置（目录节点，component 置空，由子路由渲染）
  const parentPatch = {
    component: null as null | string,
    title: parentSeed.title,
    type: parentSeed.type,
  };
  const parentNeedsUpdate =
    parent.title !== parentPatch.title ||
    parent.type !== parentPatch.type ||
    parent.component !== parentPatch.component;
  if (parentNeedsUpdate) {
    await tx.sysMenu.update({ where: { id: parent.id }, data: parentPatch });
  }

  // 2) 子菜单：缺则建、有则对齐结构字段（status 等运维字段不碰）
  let childrenCreated = 0;
  let childrenReconciled = 0;
  for (const seed of childSeeds) {
    const existing = await tx.sysMenu.findUnique({ where: { name: seed.name } });
    const fields = {
      component: seed.component ?? null,
      path: seed.path ?? null,
      pid: parent.id,
      sort: seed.sort ?? 0,
      title: seed.title,
      type: seed.type,
    };
    if (existing) {
      const differs = (Object.keys(fields) as (keyof typeof fields)[]).some(
        (key) => existing[key] !== fields[key],
      );
      if (differs) {
        await tx.sysMenu.update({ where: { id: existing.id }, data: fields });
        childrenReconciled += 1;
      }
    } else {
      await tx.sysMenu.create({ data: { ...fields, name: seed.name } });
      childrenCreated += 1;
    }
  }

  // 3) 按钮改挂最近的页面子菜单：id 映射回查全部 seed 节点（含已存在按钮）
  const seedNames = MENU_SEED.map((n) => n.name);
  const rows = await tx.sysMenu.findMany({ where: { name: { in: seedNames } } });
  const idByName = new Map(rows.map((row) => [row.name, row.id]));
  let buttonsReparented = 0;
  for (const seed of MENU_SEED as readonly MenuSeedNode[]) {
    if (seed.type !== 'button' || !seed.parent) continue;
    const row = rows.find((r) => r.name === seed.name);
    const targetPid = idByName.get(seed.parent);
    if (!row || !targetPid) continue; // 缺按钮行 = seed 还没建齐，交给 seed 自己处理
    if (row.pid !== targetPid) {
      await tx.sysMenu.update({ where: { id: row.id }, data: { pid: targetPid } });
      buttonsReparented += 1;
    }
  }

  // 4) 角色-菜单：继承"当前拥有系统设置"的角色（含运维自建角色），子菜单入口不丢
  const childIds = childSeeds
    .map((seed) => idByName.get(seed.name))
    .filter((id): id is NonNullable<typeof id> => id !== undefined);
  const parentGrants = await tx.sysRoleMenu.findMany({
    where: { menuId: parent.id },
    select: { roleId: true },
  });
  let grantsAdded = 0;
  for (const grant of parentGrants) {
    const existing = await tx.sysRoleMenu.findMany({
      where: { roleId: grant.roleId, menuId: { in: childIds } },
      select: { menuId: true },
    });
    const have = new Set(existing.map((g) => g.menuId.toString()));
    const missing = childIds.filter((id) => !have.has(id.toString()));
    if (missing.length > 0) {
      await tx.sysRoleMenu.createMany({
        data: missing.map((menuId) => ({ menuId, roleId: grant.roleId })),
        skipDuplicates: true,
      });
      grantsAdded += missing.length;
    }
  }

  return {
    buttonsReparented,
    childrenCreated,
    childrenReconciled,
    grantsAdded,
    parentUpdated: parentNeedsUpdate,
  };
}

function main(): void {
  // .env 相对 cwd 解析；pnpm -F 执行脚本时 cwd 恒为 packages/db
  loadDotenv({ quiet: true });

  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub?schema=public';

  // _test 库归测试套件管，CLI 路径显式拒绝（与 seed.ts 同一套护栏）
  assertNotTestDatabase(databaseUrl);

  const prisma = createPrismaClient(databaseUrl);
  prisma
    .$transaction((tx) => runMigrate(tx), { timeout: 30_000, maxWait: 10_000 })
    .then((result) => {
      console.log(`[db:migrate-menu] ${redact(databaseUrl)} 完成 ✅`);
      console.log(
        `  系统设置行更新 ${result.parentUpdated ? 1 : 0} | 子菜单新建 ${result.childrenCreated}` +
          `（对齐 ${result.childrenReconciled}） | 按钮改挂 ${result.buttonsReparented}` +
          ` | 角色菜单补授 ${result.grantsAdded}`,
      );
    })
    .catch((error: unknown) => {
      console.error('[db:migrate-menu] 失败，已整体回滚:', error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}

main();

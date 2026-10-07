/**
 * `pnpm db:seed` 入口：对开发/生产库跑幂等种子（M1-T3，Gate G6）。
 * 事务由外层 $transaction 提供；任何一步失败整体回滚，不留半套数据。
 * 首管随机密码只打印一次——这是部署日志的一部分（数据库设计 §8.3-5）。
 *
 * 注意：本文件会被 tsc -p tsconfig.build.json 编成 CJS（dist/seed.js），
 * 所以不用顶层 await / import.meta；运行仍走 tsx（src）或 node（dist）。
 */
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from './index';
// 显式 /index：'./seed' 会先命中本文件自己（seed.ts 与 seed/ 同名）
import { runSeed } from './seed/index';
import { assertNotTestDatabase, redact } from './seed/guard';

function main(): void {
  // .env 相对 cwd 解析；pnpm -F 执行脚本时 cwd 恒为 packages/db
  loadDotenv({ quiet: true });

  // 与 scripts/apply-migrations.mjs 同一套约定：env 优先，缺省回落本机开发库
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub?schema=public';

  // _test 库归测试套件管，CLI 路径显式拒绝（迭代实施计划 §3.6 的双向护栏）
  assertNotTestDatabase(databaseUrl);

  const prisma = createPrismaClient(databaseUrl);
  prisma
    .$transaction((tx) => runSeed(tx), { timeout: 30_000, maxWait: 10_000 })
    .then((result) => {
      console.log(`[db:seed] ${redact(databaseUrl)} 完成 ✅`);
      console.log(
        `  权限码 upsert ${result.permissionsUpserted} | 内置角色 ${result.roles}` +
          ` | 角色权限补授 ${result.rolePermissionsAdded}` +
          ` | 菜单插入 ${result.menusInserted}（已存在 ${result.menusAlreadyPresent}）` +
          ` | 角色菜单补授 ${result.roleMenusAdded}`,
      );
      if (result.superAdmin) {
        // 仅此一次输出；密码不落任何存储
        console.log(
          `  created user "${result.superAdmin.username}" with initial password: ` +
            `${result.superAdmin.password}（首次登录强制改密，请立即保存）`,
        );
      } else {
        console.log('  super_admin 用户已存在，跳过创建（幂等）');
      }
    })
    .catch((error: unknown) => {
      console.error('[db:seed] 失败，已整体回滚:', error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}

main();

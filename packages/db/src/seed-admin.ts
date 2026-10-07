/**
 * `pnpm db:seed-admin` 入口（M1-T4）：仅在库里一个 super_admin 用户都不存在时
 * 创建首个超管；随机密码打印一次、不入库明文；二次执行静默跳过（exit 0）。
 * 用法：pnpm db:seed-admin [--username <name>]
 * （不依赖 seed 之外的表数据，但要求 4 个内置角色已由 db:seed 建立——见 admin.ts 报错提示）
 */
import { config as loadDotenv } from 'dotenv';
import { createPrismaClient } from './index';
// 显式 /index，理由同 seed.ts
import { ensureFirstSuperAdmin } from './seed/index';
import { assertNotTestDatabase } from './seed/guard';
import { DEFAULT_SUPER_ADMIN_USERNAME } from './seed/admin';

function parseUsername(argv: string[]): string {
  const i = argv.indexOf('--username');
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && (value === undefined || value.startsWith('--'))) {
    console.error('[seed-admin] --username 需要一个值');
    process.exit(1);
  }
  return value ?? DEFAULT_SUPER_ADMIN_USERNAME;
}

function main(): void {
  loadDotenv({ quiet: true });

  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub?schema=public';
  assertNotTestDatabase(databaseUrl);

  const prisma = createPrismaClient(databaseUrl);
  prisma
    .$transaction(
      (tx) => ensureFirstSuperAdmin(tx, { username: parseUsername(process.argv.slice(2)) }),
      { timeout: 15_000 },
    )
    .then((created) => {
      if (created) {
        // 已存在超管时不打印任何内容、正常退出——二次执行是无声 no-op（M1-T4 判据）
        console.log(
          `created user "${created.username}" with initial password: ${created.password}` +
            '（仅打印这一次，首次登录强制改密）',
        );
      }
    })
    .catch((error: unknown) => {
      console.error('[seed-admin] 失败，已整体回滚:', error);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}

main();

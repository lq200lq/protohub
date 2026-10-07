/**
 * 重置本地 dev 库 admin 账号口令（幂等，可重复执行）。
 *
 * 用途：seed 生成的 admin 口令随机且不入库，无法回显；用户要求把管理员账号
 * 写到登录页（仅开发环境显示），因此把 admin 口令重置为下面这个固定值，并关闭
 * 首登强制改密（否则登录后被拦去改密，账号展示就失去意义）。
 * 执行需用户批准（2026-10-07 已批准）；只动 admin 自身，不碰其他账号。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));

const db = require(resolve(root, 'packages/db/dist/index.js'));
const { hashPassword } = require(resolve(root, 'packages/db/dist/seed/password.js'));

if (existsSync(resolve(root, 'packages/db/.env'))) {
  const { config } = require(resolve(root, 'packages/db/node_modules/dotenv'));
  config({ quiet: true, path: resolve(root, 'packages/db/.env') });
}

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5432/protohub?schema=public';

const USERNAME = 'admin';
const PASSWORD = 'Admin-Dev-2026!';

const prisma = db.createPrismaClient(databaseUrl);
try {
  const admin = await prisma.sysUser.findFirst({
    where: { username: USERNAME, deletedAt: null },
  });
  if (!admin) {
    console.error('admin 账号不存在——先跑 pnpm --filter @protohub/db seed');
    process.exitCode = 1;
  } else {
    await prisma.sysUser.update({
      where: { id: admin.id },
      data: {
        passwordHash: await hashPassword(PASSWORD),
        forcePasswordChange: false,
        status: 1,
      },
    });
    console.log(`reset ${USERNAME} (id=${admin.id}) password + forcePasswordChange=false`);
  }
} finally {
  await prisma.$disconnect();
}

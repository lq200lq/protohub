/**
 * 本地视觉验收用账号 uipreview（幂等，可重复执行）。
 *
 * 用途：Playwright 截图/设计走查需要一个已登录会话，仓库与文档均不落口令
 * （docs 明确"口令不入库不入文档"），故以此脚本在本地 dev 库建专用超管账号。
 * 只新增/重置 uipreview 自身，不动任何既有账号口令；执行需用户批准（2026-10-07 已批准）。
 * 密码仅存在本脚本与 /tmp 的截图脚本里，不写入文档、不入 git。
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

const USERNAME = 'uipreview';
const PASSWORD = 'UiPreview-Dev-2026!';

const prisma = db.createPrismaClient(databaseUrl);
try {
  const role = await prisma.sysRole.findFirst({
    where: { code: 'super_admin', deletedAt: null },
  });
  if (!role) throw new Error('super_admin 角色不存在——先跑 pnpm --filter @protohub/db seed');

  const passwordHash = await hashPassword(PASSWORD);
  const existing = await prisma.sysUser.findFirst({
    where: { username: USERNAME, deletedAt: null },
    include: { userRoles: true },
  });

  if (existing) {
    await prisma.sysUser.update({
      where: { id: existing.id },
      data: { passwordHash, forcePasswordChange: false, status: 1 },
    });
    if (!existing.userRoles.some((ur) => ur.roleId === role.id)) {
      await prisma.sysUserRole.create({ data: { userId: existing.id, roleId: role.id } });
    }
    console.log(`updated ${USERNAME} (id=${existing.id})`);
  } else {
    const created = await prisma.sysUser.create({
      data: {
        username: USERNAME,
        passwordHash,
        realName: '界面截图账号',
        forcePasswordChange: false,
        remark: '本地视觉验收专用（scripts/uipreview-account.mjs 创建）',
        userRoles: { create: { roleId: role.id } },
      },
    });
    console.log(`created ${USERNAME} (id=${created.id})`);
  }
} finally {
  await prisma.$disconnect();
}

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';

import { ROOT, type DbSnapshot } from './types.ts';

const require = createRequire(join(ROOT, 'noop.js'));

const DB_ENTRY = join(ROOT, 'packages/db/dist/index.js');

/**
 * DATABASE_URL 解析顺序（与 packages/db/src/seed.ts 同约定：env 优先，再回落 .env 文件）。
 * 检查脚本只读，不写库，所以可以直连开发库 protohub。
 */
const ENV_FILES = [
  join(ROOT, 'apps/server/.env.development'),
  join(ROOT, 'apps/server/.env'),
  join(ROOT, 'packages/db/.env'),
];

/** 从 dotenv 文件里取一个键（不引 dotenv，避免给 root 加依赖）。 */
function readEnvFileValue(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || !line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1).trim();
    return value.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }
  return undefined;
}

export interface ResolvedDatabaseUrl {
  url: string;
  source: string;
}

export function resolveDatabaseUrl(): ResolvedDatabaseUrl {
  if (process.env.DATABASE_URL) {
    return { source: 'process.env.DATABASE_URL', url: process.env.DATABASE_URL };
  }
  for (const file of ENV_FILES) {
    const value = readEnvFileValue(file, 'DATABASE_URL');
    if (value) {
      return { source: file.replace(`${ROOT}/`, ''), url: value };
    }
  }
  throw new Error(
    '未找到 DATABASE_URL（已尝试 process.env、apps/server/.env.development、apps/server/.env、packages/db/.env）。',
  );
}

/** 库名：连接串 pathname；测试库判定与护栏文案都基于它。 */
export function databaseNameOf(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (name.length === 0) {
    throw new Error(`DATABASE_URL 缺少库名: ${parsed.hostname}:${parsed.port}`);
  }
  return name;
}

/** 打印时隐藏口令（项目约定：日志里绝不出现连接密码）。 */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

export async function loadDbSnapshot(): Promise<DbSnapshot> {
  const { url } = resolveDatabaseUrl();
  if (!existsSync(DB_ENTRY)) {
    throw new Error(
      '找不到 packages/db/dist/index.js。请先执行 pnpm --filter @protohub/db build',
    );
  }
  const databaseName = databaseNameOf(url);
  const db = require(DB_ENTRY) as {
    createPrismaClient: (u: string) => PrismaLike;
  };

  const prisma = db.createPrismaClient(url);
  try {
    const [permissions, menus] = await Promise.all([
      prisma.sysPermission.findMany({ select: { code: true }, orderBy: { id: 'asc' } }),
      prisma.sysMenu.findMany({
        orderBy: { id: 'asc' },
        select: { authCode: true, component: true, id: true, name: true, type: true },
      }),
    ]);

    return {
      databaseName,
      menus: menus.map((menu) => ({
        authCode: menu.authCode ?? null,
        component: menu.component ?? null,
        // Prisma 返回 BigInt，Node 24 的 console.log 会直接抛，这里一律转字符串
        id: String(menu.id),
        name: menu.name,
        type: menu.type,
      })),
      permissionCodes: new Set(permissions.map((row) => row.code)),
    };
  } finally {
    await prisma.$disconnect();
  }
}

interface MenuRowRaw {
  authCode: null | string;
  component: null | string;
  id: unknown;
  name: string;
  type: string;
}

/** 只声明用到的两个模型：dist/index.js 是 @prisma/client 的再导出，形状由生成器决定。 */
interface PrismaLike {
  $disconnect: () => Promise<void>;
  sysMenu: { findMany: (args: unknown) => Promise<MenuRowRaw[]> };
  sysPermission: {
    findMany: (args: unknown) => Promise<Array<{ code: string }>>;
  };
}

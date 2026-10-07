#!/usr/bin/env node
// =============================================================================
// pnpm db:migrate 入口（M0-T4）。做五件事，全部幂等，可重复执行：
//   a) 从环境变量取 DATABASE_URL / TEST_DATABASE_URL，缺省回落到本机开发库
//      （约定值见 ../.env.example；连接串禁用主机名 localhost，一律 127.0.0.1）。
//   b) 若 protohub_test 不存在则创建（连到维护库 postgres 执行 CREATE DATABASE，
//      因为 CREATE DATABASE 不能在目标库内执行，也不允许包在事务里）。
//   c) 用 prisma migrate deploy 把 prisma/migrations/ 应用到 protohub 与
//      protohub_test 两个库——通过子进程 env 覆盖 DATABASE_URL + --schema 指定，
//      绝不改写 .env。
//   d) prisma generate（先生成一次，使本脚本能用 PrismaClient 执行原生 SQL）。
//   e) 打印每个库 public schema 下的业务表数量（不含 _prisma_migrations）。
// =============================================================================
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(PKG_ROOT, 'prisma', 'schema.prisma');

// (a) URL 解析：env 优先，缺省为文档约定值（数据库设计.md §1 / .env.example）
const DEFAULT_DATABASE_URL =
  'postgresql://postgres:postgres@127.0.0.1:5432/protohub?schema=public';
const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const TEST_DATABASE_URL = (() => {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  // 缺省：与主库同 host/credentials，库名换成 protohub_test
  const u = new URL(DATABASE_URL);
  u.pathname = '/protohub_test';
  return u.toString();
})();
const TEST_DB_NAME = new URL(TEST_DATABASE_URL).pathname.slice(1); // 'protohub_test'
const MAIN_DB_NAME = new URL(DATABASE_URL).pathname.slice(1); // 'protohub'

function log(msg) {
  console.log(`[db:migrate] ${msg}`);
}
function fail(msg) {
  console.error(`[db:migrate] ERROR: ${msg}`);
  process.exit(1);
}

// Prisma CLI 以 pnpm exec 调用（在本包目录下运行，prisma 在 devDependencies）
function prismaCli(args, url) {
  const r = spawnSync('pnpm', ['exec', 'prisma', ...args, '--schema', SCHEMA_PATH], {
    cwd: PKG_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
  if (r.status !== 0) fail(`prisma ${args.join(' ')} 失败 (exit ${r.status})`);
}

// (d) 先 generate：migrate deploy 前后各跑一次语义等价，这里跑一次即满足交付项
log('prisma generate ...');
prismaCli(['generate'], DATABASE_URL);

// 用生成的 PrismaClient 执行原生 SQL（建库、数表）
const { PrismaClient } = require('@prisma/client');

function clientFor(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function withClient(url, fn) {
  const c = clientFor(url);
  try {
    return await fn(c);
  } finally {
    await c.$disconnect();
  }
}

async function main() {
  // (b) 确保 protohub_test 存在：连维护库 postgres 执行 CREATE DATABASE
  const maintUrl = new URL(DATABASE_URL);
  maintUrl.pathname = '/postgres';
  log(`检查测试库 ${TEST_DB_NAME} 是否存在（维护连接 → ${maintUrl.host}/postgres）...`);
  await withClient(maintUrl.toString(), async (c) => {
    const rows = await c.$queryRawUnsafe(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      TEST_DB_NAME,
    );
    if (Array.isArray(rows) && rows.length > 0) {
      log(`  已存在，跳过创建`);
    } else {
      // CREATE DATABASE 不能进事务：$executeRaw 单条顶层语句自动提交，安全
      await c.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
      log(`  已创建 ${TEST_DB_NAME}`);
    }
  });

  // (c) 两个库分别 migrate deploy（env 覆盖 URL，不改 .env）
  for (const [name, url] of [
    [MAIN_DB_NAME, DATABASE_URL],
    [TEST_DB_NAME, TEST_DATABASE_URL],
  ]) {
    log(`prisma migrate deploy → ${name} ...`);
    prismaCli(['migrate', 'deploy'], url);
  }

  // (e) 打印每个库的业务表数量（public schema，排除 Prisma 内部表）
  for (const [name, url] of [
    [MAIN_DB_NAME, DATABASE_URL],
    [TEST_DB_NAME, TEST_DATABASE_URL],
  ]) {
    const count = await withClient(url, (c) =>
      c.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            AND table_name <> '_prisma_migrations'`,
      ),
    );
    const n = Number(count?.[0]?.count ?? -1);
    if (n < 0) fail(`无法统计 ${name} 的表数量`);
    log(`${name}: public schema 下业务表 ${n} 张（不含 _prisma_migrations）`);
  }
  log('完成 ✅');
}

main().catch((e) => fail(e?.stack ?? String(e)));

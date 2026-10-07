/**
 * 测试库/开发库护栏（迭代实施计划 §3.6）。
 *
 * 两条红线，都在代码里显式断言而不是靠人记住：
 *  1. `db:seed` / `db:seed-admin` 入口拒绝连 *_test 库（生产数据不能进测试库，
 *     也避免误把开发脚本当测试跑）。
 *  2. seed 集成测试只允许连 *_test 库，不是就抛错拒跑（防止把开发数据清掉）。
 */
import { URL } from 'node:url';

/** 约定：测试库库名以 _test 结尾（数据库设计 §1 / .env.example）。 */
export const TEST_DB_SUFFIX = '_test';

export function databaseNameOf(url: string): string {
  // pathname 形如 '/protohub_test'；连接串按项目约定必须是 127.0.0.1 + 显式库名
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name.length === 0) {
    throw new Error(`DATABASE_URL 缺少库名: ${redact(url)}`);
  }
  return name;
}

export function isTestDatabaseUrl(url: string): boolean {
  return databaseNameOf(url).endsWith(TEST_DB_SUFFIX);
}

/** 测试入口守卫：不是 _test 库就直接抛，拒绝执行任何写操作。 */
export function assertTestDatabase(url: string): void {
  if (!isTestDatabaseUrl(url)) {
    throw new Error(
      `[seed-guard] 拒绝执行：当前库 "${databaseNameOf(url)}" 不是测试库（约定库名须以 "${TEST_DB_SUFFIX}" 结尾）。` +
        '集成测试只允许跑在 protohub_test 上（迭代实施计划 §3.6）。',
    );
  }
}

/** seed/seed-admin CLI 入口守卫：拒绝把种子数据写进测试库（那是测试套件的地盘）。 */
export function assertNotTestDatabase(url: string): void {
  if (isTestDatabaseUrl(url)) {
    throw new Error(
      `[seed-guard] 拒绝执行：db:seed / db:seed-admin 不允许写测试库 "${databaseNameOf(url)}"；` +
        '测试库由 vitest 套件（protohub_test）自行重置。',
    );
  }
}

/** 打印/报错时隐藏密码，连接串里只保留 host 与库名。 */
export function redact(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

/**
 * `pnpm check:consistency` —— 契约一致性检查（迭代实施计划 §3.6、§5 M1-T16、§6.4 N1/N2）。
 *
 * 覆盖七条检查（编号见 scripts/consistency/rules/）：
 *   R1   PERMISSIONS（packages/shared 构建产物）↔ sys_permission，双向
 *   R2   apps/server/src 里每个 @RequirePermission('…') 的码都在 PERMISSIONS 里（正则扫源码）
 *   R3a  sys_menu.component ↔ apps/admin/src/views 真实 .vue（vben `route component is invalid` 的机械版）
 *   R3b  sys_menu.auth_code ⊆ PERMISSIONS
 *   R4   migrations 里 proto_project/proto_prototype 的 code CHECK 正则与长度 = shared CODE_RULE
 *   R5   apps/admin/src 里的权限码字面量 ⊆ PERMISSIONS
 *   R6   权限码落点双向（M5-T4）：每个码后端有 @RequirePermission、前端有落点（P1 码白名单）
 *
 * 数据库连接策略（按计划要求，刻意不做"库名前缀"护栏）：
 *   连的就是 DATABASE_URL 指的库（顺序：process.env → apps/server/.env.development →
 *   apps/server/.env → packages/db/.env）。本脚本全程只读，不写库、不建库、不 seed。
 *   若目标库名以 _test 结尾或显式 ALLOW_TEST_DB=1，打一条警告 banner：测试库内容由 vitest
 *   套件重置，seed 没跑之前权限/菜单计数与常量不一致属预期。
 *   连不上库 = 相关规则判失败（不能因为"没连上"而绿）。
 *
 * 退出码：任一规则失败即 1，全绿 0。
 */
import {
  databaseNameOf,
  loadDbSnapshot,
  redactUrl,
  resolveDatabaseUrl,
  type ResolvedDatabaseUrl,
} from './consistency/load-db.ts';
import { printResults } from './consistency/report.ts';
import { RULES } from './consistency/rules/index.ts';
import { loadSharedContracts } from './consistency/load-contracts.ts';
import {
  fail,
  type DbSnapshot,
  type RuleContext,
  type RuleResult,
} from './consistency/types.ts';

const DB_RULE_IDS = new Set(['R1', 'R3a', 'R3b']);

async function main(): Promise<void> {
  const header: string[] = ['protoHub 契约一致性检查（M1-T16）'];

  // 契约来源：shared 的构建产物（CJS）。拿不到就直接失败——没有唯一来源时无从比对。
  let contracts;
  try {
    contracts = loadSharedContracts();
  } catch (error) {
    console.log(header[0] ?? '');
    console.log(`✘ 无法加载 packages/shared 契约：${explainError(error)}`);
    process.exit(1);
    return;
  }

  let resolved: ResolvedDatabaseUrl | undefined;
  let dbError: unknown;
  try {
    resolved = resolveDatabaseUrl();
  } catch (error) {
    dbError = error;
  }

  let db: DbSnapshot | null = null;
  if (resolved) {
    const name = databaseNameOf(resolved.url);
    header.push(`DB  ${resolved.source} → ${redactUrl(resolved.url)}（库名 ${name}）`);
    if (name.endsWith('_test') || process.env.ALLOW_TEST_DB === '1') {
      header.push(
        `⚠ ${name} 是测试库：内容由 vitest 套件重置，未跑 seed 时权限/菜单计数会比 PERMISSIONS 少，属预期差异`,
      );
    }
    try {
      db = await loadDbSnapshot();
    } catch (error) {
      dbError = error;
    }
  }

  const dbFailureReason = dbError ? explainError(dbError) : null;
  if (dbFailureReason) header.push(`⚠ 无法读取数据库：${dbFailureReason}`);

  // R2/R4/R5 不读 ctx.db，所以连不上时用空快照占位即可；DB 规则单独记失败。
  const ctx: RuleContext = {
    codeRule: contracts.codeRule,
    db:
      db ?? { databaseName: '(未连接)', menus: [], permissionCodes: new Set() },
    permissionCodes: contracts.permissionCodes,
  };

  const results: RuleResult[] = [];
  for (const rule of RULES) {
    if (!db && DB_RULE_IDS.has(rule.id)) {
      results.push(
        fail(rule.id, rule.title, [
          {
            message: `未能验证：${dbFailureReason ?? '未找到 DATABASE_URL'}（脚本只读，不代为建库或跑 seed）`,
            where: 'DATABASE_URL',
          },
        ]),
      );
      continue;
    }
    results.push(await rule.run(ctx));
  }

  process.exit(printResults(results, header) ? 0 : 1);
}

/**
 * Prisma 的报错形如 `Invalid \`prisma.x.findMany()\` invocation:\n\nCan't reach database server at …`，
 * 首行只有类信息，真正的原因在后面的行里——挑那条，别把噪音抄给用户。
 */
function explainError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: string } | undefined)?.message ?? error);
  const lines = message
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (lines.length === 0) return '未知错误';
  const REASON =
    /can'?t reach|econnrefused|authentication failed|does not exist|timed out|permission denied|P10\d\d/i;
  const candidate =
    lines.find((line) => REASON.test(line) && !line.startsWith('Invalid `prisma')) ??
    lines.reduce((longest, line) => (line.length > longest.length ? line : longest), lines[0] as string);
  return candidate.length > 160 ? `${candidate.slice(0, 160)}…` : candidate;
}

await main();

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** scripts/consistency/types.ts → 仓库根（不依赖 cwd，pnpm -F 执行时 cwd 会变）。 */
export const THIS_FILE = fileURLToPath(import.meta.url);
export const ROOT = resolve(THIS_FILE, '../../..');

/** 一条违规：定位到 file:line（无法定位时给 db 行/常量的标识）。 */
export interface Finding {
  /** 展示用位置，例如 `apps/server/src/.../user.controller.ts:54` 或 `sys_menu#12` */
  where: string;
  /** 一句话说清哪里不对 */
  message: string;
}

export type RuleStatus = 'failed' | 'passed' | 'skipped';

export interface RuleResult {
  id: string;
  title: string;
  status: RuleStatus;
  findings: Finding[];
  /** 通过时也打印一行细节（命中数量等），便于确认规则真的跑了 */
  notes: string[];
  /** skipped 的原因 */
  skipReason?: string;
}

export interface RuleContext {
  /** 权限码唯一来源：packages/shared 构建产物里的 PERMISSIONS */
  permissionCodes: Set<string>;
  /** CODE_RULE（shared）与 migrations 里的 code CHECK 都要等它 */
  codeRule: { maxLength: number; pattern: RegExp };
  db: DbSnapshot;
}

export interface DbSnapshot {
  /** sys_permission.code 全集 */
  permissionCodes: Set<string>;
  /** sys_menu：component / auth_code 检查用 */
  menus: Array<{
    authCode: null | string;
    component: null | string;
    id: string;
    name: string;
    type: string;
  }>;
  /** 连上的库名：只出现在报错定位里，连接串本身由 load-db 负责 redact */
  databaseName: string;
}

export interface Rule {
  id: string;
  title: string;
  run: (ctx: RuleContext) => Promise<RuleResult> | RuleResult;
}

export function pass(
  id: string,
  title: string,
  notes: string[] = [],
): RuleResult {
  return { findings: [], id, notes, status: 'passed', title };
}

export function fail(
  id: string,
  title: string,
  findings: Finding[],
  notes: string[] = [],
): RuleResult {
  return { findings, id, notes, status: 'failed', title };
}

export function skip(
  id: string,
  title: string,
  reason: string,
): RuleResult {
  return {
    findings: [],
    id,
    notes: [],
    skipReason: reason,
    status: 'skipped',
    title,
  };
}

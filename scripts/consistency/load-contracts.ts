import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT, type RuleContext } from './types.ts';

/** scripts/ 下的裸脚本没有 workspace 依赖可解析，用绝对路径 require 构建产物（CJS）。 */
const require = createRequire(join(ROOT, 'noop.js'));

const SHARED_ENTRY = join(ROOT, 'packages/shared/dist/index.js');

/**
 * 契约的唯一来源 = 构建后的 packages/shared。
 * dist 缺失或过旧都会让比对失去意义，所以这里直接抛错，由入口打印成失败而不是静默跳过。
 */
export function loadSharedContracts(): Pick<RuleContext, 'codeRule' | 'permissionCodes'> {
  if (!existsSync(SHARED_ENTRY)) {
    throw new Error(
      '找不到 packages/shared/dist/index.js，请先执行 pnpm --filter @protohub/shared build',
    );
  }
  const shared = require(SHARED_ENTRY) as {
    CODE_RULE?: { maxLength: number; pattern: RegExp };
    PERMISSIONS?: Array<{ code: string }>;
  };

  const { CODE_RULE: codeRule, PERMISSIONS: permissions } = shared;
  if (!Array.isArray(permissions) || !codeRule?.pattern) {
    throw new Error(
      'packages/shared/dist 里缺少 PERMISSIONS 或 CODE_RULE —— dist 版本过旧，请重新 build',
    );
  }

  return {
    codeRule: { maxLength: codeRule.maxLength, pattern: codeRule.pattern },
    permissionCodes: new Set(permissions.map((permission) => permission.code)),
  };
}

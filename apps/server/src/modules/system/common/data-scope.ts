import type { DataScope } from '@protohub/shared';

/**
 * 数据范围宽窄（权限模型设计 §6.1 + 约束 C-6"多角色取最宽"）。
 * 放在 system 模块内部而不是 import auth：auth 侧的同名实现位于 account.service.ts，
 * 那个模块图当前会加载 @protohub/db（见交付报告），常量本身没有第二处定义的风险。
 */
const SCOPE_WIDTH: Record<DataScope, number> = { all: 3, member: 2, own: 1 };

/** 没有任何角色时的兜底：取最窄，宁可不给可见也不越权。 */
export const NARROWEST_DATA_SCOPE: DataScope = 'own';

export function dataScopeWidth(scope: DataScope): number {
  return SCOPE_WIDTH[scope];
}

export function widestDataScope(scopes: readonly DataScope[]): DataScope {
  return scopes.reduce<DataScope>(
    (widest, scope) => (SCOPE_WIDTH[scope] > SCOPE_WIDTH[widest] ? scope : widest),
    NARROWEST_DATA_SCOPE,
  );
}

/** DB 里 data_scope 是 varchar + CHECK 约束；读到非法值时按最窄处理而不是 500。 */
export function toDataScope(value: string): DataScope {
  return value === 'all' || value === 'member' || value === 'own'
    ? value
    : NARROWEST_DATA_SCOPE;
}

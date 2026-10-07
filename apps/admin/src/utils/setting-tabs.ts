import type { PermissionCode } from '@protohub/shared';

/** 设置页 Tab（前端设计 §3.8）：无权限的 Tab 不渲染，而不是置灰 */
export type SettingTabKey =
  | 'log'
  | 'menu'
  | 'role'
  | 'security'
  | 'user';

export interface SettingTabDefinition {
  /** null 表示仅需登录 */
  code: null | PermissionCode;
  key: SettingTabKey;
}

export const SETTING_TABS: readonly SettingTabDefinition[] = [
  { code: null, key: 'security' },
  { code: 'system:user:list', key: 'user' },
  { code: 'system:role:list', key: 'role' },
  { code: 'system:menu:list', key: 'menu' },
  { code: 'system:log:list', key: 'log' },
];

/** 权限码 → 可见 Tab 的纯映射（单测覆盖） */
export function resolveSettingTabs(codes: readonly string[]): SettingTabKey[] {
  return SETTING_TABS.filter(
    (tab) => tab.code === null || codes.includes(tab.code),
  ).map((tab) => tab.key);
}

/** query 里的 ?tab= 可能来自旧收藏/手输：不在可见集合里就回落到第一个可见 Tab */
export function pickSettingTab(
  requested: null | string | undefined,
  visible: readonly SettingTabKey[],
): SettingTabKey | undefined {
  const hit = visible.find((key) => key === requested);
  return hit ?? visible[0];
}

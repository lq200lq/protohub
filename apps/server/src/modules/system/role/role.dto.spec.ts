import { describe, expect, it } from 'vitest';

import { ROLE_CODE_PATTERN, isRoleCodeValid } from './role.dto';

/**
 * role.dto 的纯校验规则单测（zod schema 层，不起 Nest 上下文）。
 * 契约点：code 只可小写 slug；内置角色的 code 在 update 契约里根本不存在（C-1 的第一道闸）。
 */
describe('role.dto 校验规则', () => {
  it('code 形态：小写字母开头、允许数字/下划线/短横线', () => {
    expect(ROLE_CODE_PATTERN.test('publisher')).toBe(true);
    expect(ROLE_CODE_PATTERN.test('audit_viewer-1')).toBe(true);
    expect(ROLE_CODE_PATTERN.test('AuditViewer')).toBe(false);
    expect(ROLE_CODE_PATTERN.test('1bad')).toBe(false);
    expect(isRoleCodeValid('a')).toBe(false);
  });

  it('updateRoleSchema 拒绝任何带 code 的提交（内置角色 code 不可改，C-1）', async () => {
    const { updateRoleSchema } = await import('./role.dto');
    const result = updateRoleSchema.safeParse({
      code: 'super_admin',
      name: '改名',
      dataScope: 'all',
    });
    expect(result.success).toBe(false);
  });

  it('createRoleSchema 拒绝 builtIn 注入', async () => {
    const { createRoleSchema } = await import('./role.dto');
    const result = createRoleSchema.safeParse({
      code: 'qa_lead',
      name: '质量负责人',
      dataScope: 'member',
      builtIn: true,
    });
    expect(result.success).toBe(false);
  });

  it('assignRolePermissionsSchema 去重且拒绝非法菜单 id', async () => {
    const { assignRolePermissionsSchema } = await import('./role.dto');
    const parsed = assignRolePermissionsSchema.safeParse({
      permissionCodes: ['system:role:list', 'system:role:list', 'system:user:read'],
      menuIds: ['3', '7'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.permissionCodes).toEqual(['system:role:list', 'system:user:read']);
    }
    expect(
      assignRolePermissionsSchema.safeParse({ permissionCodes: [], menuIds: ['abc'] }).success,
    ).toBe(false);
  });
});

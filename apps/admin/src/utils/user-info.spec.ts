import { describe, expect, it } from 'vitest';

import { hasForcePasswordChange } from './user-info';
import { validatePasswordStrength } from './password';

describe('hasForcePasswordChange', () => {
  it('只在后端契约字段 forcePasswordChange 为 true 时要求强制改密（§2.5）', () => {
    expect(hasForcePasswordChange({ forcePasswordChange: true })).toBe(true);
    expect(hasForcePasswordChange({ forcePasswordChange: 'true' })).toBe(false);
    expect(hasForcePasswordChange({ username: 'admin' })).toBe(false);
  });

  it('对 null/undefined 安全返回 false', () => {
    expect(hasForcePasswordChange(null)).toBe(false);
    expect(hasForcePasswordChange(undefined)).toBe(false);
  });
});

describe('validatePasswordStrength（§2.8）', () => {
  it('要求 ≥8 位且至少 3 类字符', () => {
    expect(validatePasswordStrength('Abcdef1!')).toBe(true);
    expect(validatePasswordStrength('Abcdefgh')).toBe(false); // 仅大小写 2 类
    expect(validatePasswordStrength('Ab1!xyz')).toBe(false); // 不足 8 位
    expect(validatePasswordStrength('abcdefgh')).toBe(false); // 只有一类字符
    expect(validatePasswordStrength('Abcdefg1')).toBe(true);
  });
});

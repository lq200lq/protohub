import { describe, expect, it } from 'vitest';

import {
  groupPermissionsByModule,
  isPermissionCode,
  PERMISSION_CODES,
  PERMISSIONS,
} from '../constants/permissions';

/** 权限模型设计 §3 的逐条清单（§3.1–§3.6），条数与取值以此为准 */
const DOC_PERMISSION_CODES = [
  'dashboard:workspace:view',

  'proto:project:list',
  'proto:project:read',
  'proto:project:create',
  'proto:project:update',
  'proto:project:delete',
  'proto:project:archive',

  'proto:prototype:list',
  'proto:prototype:read',
  'proto:prototype:create',
  'proto:prototype:update',
  'proto:prototype:delete',
  'proto:prototype:archive',
  'proto:prototype:policy',
  'proto:prototype:publish',
  'proto:prototype:rollback',

  'proto:release:list',
  'proto:release:delete',
  'proto:release:download',

  'proto:accesslog:list',
  'proto:accesslog:export',

  'system:user:list',
  'system:user:read',
  'system:user:create',
  'system:user:update',
  'system:user:delete',
  'system:user:resetpwd',
  'system:user:assignrole',
  'system:role:list',
  'system:role:read',
  'system:role:create',
  'system:role:update',
  'system:role:delete',
  'system:role:assignperm',
  'system:menu:list',
  'system:menu:create',
  'system:menu:update',
  'system:menu:delete',
  'system:log:list',
];

describe('PERMISSIONS', () => {
  it('无重复权限码', () => {
    const codes = PERMISSIONS.map((permission) => permission.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(PERMISSION_CODES).toEqual(codes);
  });

  it('与权限模型设计 §3 逐条对齐：无遗漏无多余', () => {
    expect([...PERMISSION_CODES].toSorted()).toEqual([...DOC_PERMISSION_CODES].toSorted());
    expect(PERMISSIONS.length).toBe(39);
  });

  it('命名规范 {域}:{资源}:{操作}，全小写冒号分隔', () => {
    for (const permission of PERMISSIONS) {
      expect(permission.code).toMatch(/^[a-z]+(?::[a-z]+){2}$/);
      expect(permission.name.length).toBeGreaterThan(0);
      expect(['dashboard', 'proto', 'system']).toContain(permission.module);
    }
  });

  it('项目/原型/版本三级权限码各自独立存在', () => {
    expect(PERMISSION_CODES.filter((code) => code.startsWith('proto:project:'))).toHaveLength(6);
    expect(
      PERMISSION_CODES.filter((code) => code.startsWith('proto:prototype:')),
    ).toHaveLength(9);
    expect(PERMISSION_CODES.filter((code) => code.startsWith('proto:release:'))).toHaveLength(3);
    expect(PERMISSION_CODES).toContain('proto:prototype:policy');
    expect(PERMISSION_CODES).not.toContain('proto:project:publish');
  });

  it('isPermissionCode 只认清单内的码', () => {
    expect(isPermissionCode('proto:prototype:publish')).toBe(true);
    expect(isPermissionCode('proto:prototype:whatever')).toBe(false);
    expect(isPermissionCode('')).toBe(false);
  });

  it('分组结果覆盖全集且不重不漏', () => {
    const groups = groupPermissionsByModule();
    expect(groups.map((group) => group.module).toSorted()).toEqual([
      'dashboard',
      'proto',
      'system',
    ]);
    const flat = groups.flatMap((group) => group.permissions.map((item) => item.code));
    expect(flat.toSorted()).toEqual([...PERMISSION_CODES].toSorted());
  });
});

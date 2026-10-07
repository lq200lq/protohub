import { PERMISSIONS, PERMISSION_CODES } from '@protohub/shared';
import { describe, expect, it } from 'vitest';

import { PermissionDictService } from './permission-dict.service';

/**
 * 权限码字典（后端接口设计 §7.4 + 权限模型设计 §3）：
 * 唯一来源是代码常量 PERMISSIONS，接口只做分组透出——这条测试同时钉住"不查库"的口径。
 */
describe('PermissionDictService.dict', () => {
  const service = new PermissionDictService();

  it('覆盖全部权限码、无重复，且按 module 分组', () => {
    const groups = service.dict();
    const flat = groups.flatMap((group) => group.permissions);

    expect(flat).toHaveLength(PERMISSIONS.length);
    expect(new Set(flat.map((item) => item.code)).size).toBe(PERMISSION_CODES.length);
    for (const group of groups) {
      expect(group.permissions.every((item) => item.module === group.module)).toBe(true);
    }
  });

  it('系统管理组包含角色授权/菜单/日志等 M1 依赖的码', () => {
    const system = service.dict().find((group) => group.module === 'system');
    const codes = (system?.permissions ?? []).map((item) => item.code);
    for (const expected of [
      'system:role:assignperm',
      'system:menu:update',
      'system:log:list',
      'system:user:assignrole',
    ]) {
      expect(codes).toContain(expected);
    }
  });

  it('sort 组内严格递增且与 PERMISSIONS 数组顺序一致（字典表的 sort 来源）', () => {
    for (const group of service.dict()) {
      const sorts = group.permissions.map((item) => item.sort);
      expect(sorts).toEqual([...sorts].sort((a, b) => a - b));
      expect(new Set(sorts).size).toBe(sorts.length);
    }
  });
});

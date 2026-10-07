import { Injectable } from '@nestjs/common';
import {
  PERMISSIONS,
  groupPermissionsByModule,
  type PermissionDictGroup,
  type PermissionDictItem,
} from '@protohub/shared';

/**
 * 权限码字典（后端接口设计 §7.4）：**只读、以代码常量 PERMISSIONS 为唯一来源**（权限模型设计 §3）。
 *
 * 为什么不查 `sys_permission` 表：字典与 Guard/`@RequirePermission` 编译期校验的是同一份常量，
 * 表只是 seed 出来的授权外键目标；如果接口从表读，seed 漂移会让"界面勾选的码"与"后端认的码"不一致。
 */
@Injectable()
export class PermissionDictService {
  /** 数组顺序即 sort（PERMISSIONS 顶部注释的约定），组内稳定升序。 */
  dict(): PermissionDictGroup[] {
    const sortOf = new Map<string, number>(
      PERMISSIONS.map((permission, index) => [permission.code, index + 1]),
    );
    return groupPermissionsByModule().map((group) => ({
      module: group.module,
      permissions: group.permissions.map((permission): PermissionDictItem => ({
        code: permission.code,
        name: permission.name,
        module: permission.module,
        sort: sortOf.get(permission.code) ?? 0,
      })),
    }));
  }
}

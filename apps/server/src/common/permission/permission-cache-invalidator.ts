import type { PermissionCodeService } from './permission-code.service';

/**
 * 权限码缓存失效的**接缝**（权限模型设计 §8.2 / 后端接口设计 §7.2.6）。
 *
 * 契约放在鉴权底座（本目录），实现由 `PermissionModule` 提供并导出；
 * 写入方（system 的 user/role/menu 服务）只认这个令牌，不 `import` 读方的实现细节。
 * 依赖方向因此始终是 业务模块 → 底座，不形成反向依赖。
 *
 * 必须失效的三类时机（§8.2：改角色权限 / 改用户角色 / 禁用用户）。
 */
export const PERMISSION_CACHE_INVALIDATOR =
  'protohub:permission-cache-invalidator';

export interface PermissionCacheInvalidator {
  /** 单个用户的权限码缓存失效（改用户角色、禁用用户、软删用户、改密）。 */
  invalidateUser(userId: string): Promise<void> | void;
  /** 某角色下所有用户的权限码缓存失效（改角色权限、改角色状态、删角色）。 */
  invalidateRole(roleId: string): Promise<void> | void;
  /** 兜底：一次请求里改了多个角色时整体清空。 */
  invalidateAll(): Promise<void> | void;
}

/**
 * 把 `PermissionCodeService` 的失效方法适配成接缝形状。
 *
 * 单独导出而不在模块里内联：这是"权限改动即时生效"的唯一通路，
 * M1 Gate G4 要能对着它做断言（改角色权限后旧令牌的 codes 立刻变）。
 */
export function createPermissionCacheInvalidator(
  service: PermissionCodeService,
): PermissionCacheInvalidator {
  return {
    invalidateUser: (userId) => service.invalidateUser(userId),
    invalidateRole: (roleId) => service.invalidateRole(roleId),
    invalidateAll: () => service.invalidateAll(),
  };
}

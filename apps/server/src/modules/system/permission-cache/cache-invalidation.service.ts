import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  PERMISSION_CACHE_INVALIDATOR,
  type PermissionCacheInvalidator,
} from '../../../common/permission/permission-cache-invalidator';

/**
 * 服务层调用失效的地方一律经过这里，而不是直接抛错：
 * 失效是"锦上添花"的第二道保险（第一道是 30 秒 TTL），它失败不该让已经提交成功的事务回滚或把请求打成 500。
 * 但失败必须进日志——F-15 的症状就是"改了权限不生效，只能重启"。
 *
 * 注入用**非 @Optional**：漏接线时 Nest 在启动期就报错，而不是运行期静默 no-op。
 * （M1 Gate G4 第一版就是栽在 `@Optional() + Noop` 上：改角色权限返回 200，旧令牌的权限码却 30 秒不变。）
 */
@Injectable()
export class CacheInvalidation {
  private readonly logger = new Logger(CacheInvalidation.name);

  constructor(
    @Inject(PERMISSION_CACHE_INVALIDATOR)
    private readonly invalidator: PermissionCacheInvalidator,
  ) {}

  async forUser(userId: string): Promise<void> {
    await this.run(`user:${userId}`, () =>
      this.invalidator.invalidateUser(userId),
    );
  }

  async forRole(roleId: string): Promise<void> {
    await this.run(`role:${roleId}`, () =>
      this.invalidator.invalidateRole(roleId),
    );
  }

  async forAll(): Promise<void> {
    await this.run('all', () => this.invalidator.invalidateAll());
  }

  private async run(label: string, action: () => unknown): Promise<void> {
    try {
      await action();
    } catch (error: unknown) {
      this.logger.warn(
        { label, error: error instanceof Error ? error.message : String(error) },
        `权限码缓存失效调用失败（${label}），最多 30 秒后自然过期`,
      );
    }
  }
}

import { Module } from '@nestjs/common';

import { PermissionModule } from '../../../common/permission/permission.module';
import { CacheInvalidation } from './cache-invalidation.service';

/**
 * 权限码缓存失效的写侧外壳（权限模型设计 §8.2）。
 *
 * 本体（缓存 + 实现）在鉴权底座 `PermissionModule`，这里只 import 它并把令牌转出去。
 * 兜底的 Noop 实现已删除：静默 no-op 正是 G4 第一版失败的原因，接不上线就该在启动期炸。
 */
@Module({
  imports: [PermissionModule],
  providers: [CacheInvalidation],
  exports: [CacheInvalidation],
})
export class PermissionCacheModule {}

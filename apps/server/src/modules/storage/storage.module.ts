import { Global, Module } from '@nestjs/common';

import { LocalStorageAdapter } from './local-storage.adapter';
import { STORAGE_ADAPTER } from './storage.adapter';

/**
 * 平台设计方案 §7.1：StorageAdapter（本地磁盘实现，S3 预留）。
 *
 * 做成 `@Global`：发布受理、commit、M4 的静态直出与 M5 的 GC 都要读写产物，
 * 与 AppConfigModule 同理，避免每个模块重复 import。
 * 业务注入 `STORAGE_ADAPTER`（接口令牌）而不是具体类，换实现不动调用方。
 */
@Global()
@Module({
  providers: [
    LocalStorageAdapter,
    { provide: STORAGE_ADAPTER, useExisting: LocalStorageAdapter },
  ],
  exports: [STORAGE_ADAPTER, LocalStorageAdapter],
})
export class StorageModule {}

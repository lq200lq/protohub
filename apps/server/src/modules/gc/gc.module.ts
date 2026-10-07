import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module';
import { SystemDataModule } from '../system/persistence/system-data.module';
import { GcService } from './gc.service';

/**
 * 垃圾回收（[原型发布与访问机制.md](../../../../docs/原型发布与访问机制.md) §4.3；迭代实施计划 M5-T6）。
 *
 * 只依赖两样：DB（`PRISMA_CLIENT`，删任务/日志、标记版本）与存储（`STORAGE_ADAPTER`，
 * list/move/delete）。刻意不引任何业务模块——GC 判的是"记录与产物对不对得上"，
 * 一旦跟着发布链路走，回收规则就会随业务一起漂，没人守得住它。
 */
@Module({
  imports: [StorageModule, SystemDataModule],
  providers: [GcService],
  exports: [GcService],
})
export class GcModule {}

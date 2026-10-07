import { Module } from '@nestjs/common';

import { OperationAuditWriter } from './operation-audit.writer';
import { SystemDataModule } from '../persistence/system-data.module';

/**
 * 审计写入能力。凡是有写操作的子模块（user/role/menu）都要 imports 它——
 * 迭代实施计划 M1-T14 与 §3.7 要求"每个写接口留下脱敏后的 before/after"。
 *
 * 类名带 System 前缀：`AuditModule` 这个名字已被 operation-audit.writer.ts 用作
 * 审计归属模块的字面量联合类型（`'system:user' | ...`），同名会让 `import * as` 与
 * 反向引用（服务层引类型、模块引类）在阅读时无法区分。
 */
@Module({
  imports: [SystemDataModule],
  providers: [OperationAuditWriter],
  exports: [OperationAuditWriter],
})
export class SystemAuditModule {}

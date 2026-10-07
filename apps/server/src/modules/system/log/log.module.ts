import { Module } from '@nestjs/common';

import { SystemDataModule } from '../persistence/system-data.module';
import { LogController } from './log.controller';
import { LogService } from './log.service';

/** 平台设计方案 §7.1 / 后端接口设计 §7.5：登录日志与操作日志的只读查询（M1-T14 后端侧）。 */
@Module({
  imports: [SystemDataModule],
  controllers: [LogController],
  providers: [LogService],
  exports: [LogService],
})
export class LogModule {}

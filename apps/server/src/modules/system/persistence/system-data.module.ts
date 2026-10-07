import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { AppEnvService } from '../../../config/app-env.service';
import { AppConfigModule } from '../../../config/config.module';
import { PRISMA_CLIENT } from './prisma-token';

/**
 * system 模块的数据库接入。
 *
 * 令牌与 common/permission/prisma-client.ts 的 `PRISMA_CLIENT` 同值，因此 auth 侧落地全局
 * DataModule 后，把这个模块删掉、在 AppModule 里换成全局数据模块即可，服务层零改动。
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [AppEnvService],
      useFactory: (env: AppEnvService): PrismaClient =>
        new PrismaClient({ datasources: { db: { url: env.env.db.url } } }),
    },
  ],
  exports: [PRISMA_CLIENT],
})
export class SystemDataModule {}

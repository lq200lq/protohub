import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { join, resolve } from 'node:path';

import { AppEnvService } from './app-env.service';
import { APP_ENV_KEY } from './constants';
import { parseEnv } from './env';

/**
 * `APP_ENV_KEY` 定义在 constants.ts：app-env.service 也要用它，
 * 放在本文件里会形成 config.module ↔ app-env.service 的循环 require（Nest 直接报 CircularDependency）。
 */

/**
 * src/config 与 dist/config 都正好位于包根目录下一层，所以 __dirname 上溯两级恒等于 apps/server。
 * 用绝对路径而不是依赖 cwd：`node apps/server/dist/main.js`（从仓库根跑）也能读到自己的 .env。
 */
const packageRoot = resolve(__dirname, '..', '..');

export function envFileCandidates(
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
): string[] {
  return [join(packageRoot, `.env.${nodeEnv}`), join(packageRoot, '.env')];
}

/** 配置是横切能力（守卫、Cookie、审计、GC 都要读阈值），做成全局避免每个模块重复 import。 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: envFileCandidates(),
      // validate 在模块初始化之前执行：配置不合法就让启动炸掉，不要等到某个请求踩到 undefined。
      validate: (raw: Record<string, unknown>) => ({
        ...raw,
        [APP_ENV_KEY]: parseEnv(raw),
      }),
    }),
  ],
  providers: [AppEnvService],
  exports: [AppEnvService],
})
export class AppConfigModule {}

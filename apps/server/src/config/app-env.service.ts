import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { APP_ENV_KEY } from './constants';
import { EnvConfigError, type AppEnv } from './env';

/** 业务模块拿配置的唯一入口；缺它说明 AppConfigModule 没接上，属于编程错误而非运维问题。 */
@Injectable()
export class AppEnvService {
  readonly env: AppEnv;

  constructor(config: ConfigService) {
    const env = config.get<AppEnv>(APP_ENV_KEY);
    if (!env) {
      throw new EnvConfigError([
        `内部错误：配置容器里没有 "${APP_ENV_KEY}"，AppConfigModule 的 validate 未生效`,
      ]);
    }
    this.env = env;
  }
}

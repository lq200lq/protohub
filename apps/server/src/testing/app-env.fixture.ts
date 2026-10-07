import type { ConfigService } from '@nestjs/config';

import { AppEnvService } from '../config/app-env.service';
import { APP_ENV_KEY } from '../config/constants';
import { parseEnv } from '../config/env';
import { baseEnvRaw } from './env.fixture';

/**
 * 用一份合法的环境变量造出 `AppEnvService`。
 *
 * 走真实的 `parseEnv` 而不是手写对象：这样 `cookieSecure` 由 NODE_ENV 推导的行为
 * （开发/测试无 Secure、生产有 Secure）在测试里也是真的在验配置层，而不是验一个假数据。
 */
export function fakeAppEnv(overrides: Record<string, unknown> = {}): AppEnvService {
  const env = parseEnv(baseEnvRaw(overrides));
  const config = {
    get: (key: string): unknown => (key === APP_ENV_KEY ? env : undefined),
  };
  return new AppEnvService(config as unknown as ConfigService);
}

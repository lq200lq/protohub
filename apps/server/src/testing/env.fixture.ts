import { SECRET_ENV_KEYS, type SecretEnvKey } from '../config/constants';

/** 四个互不相同、长度达标的假密钥；只在测试里用，绝不进生产配置。 */
export const TEST_SECRETS: Record<SecretEnvKey, string> = {
  JWT_ACCESS_SECRET: 'test-only-jwt-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-only-jwt-refresh-secret-0123456789abcdef',
  SESSION_COOKIE_SECRET: 'test-only-session-cookie-secret-0123456789abcdef',
  ACCESS_TOKEN_SECRET: 'test-only-access-token-secret-0123456789abcdef',
};

/** 一份合法的开发环境变量原始值，可用 overrides 制造缺失/重复等缺陷。 */
export function baseEnvRaw(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const secrets = Object.fromEntries(
    SECRET_ENV_KEYS.map((key) => [key, TEST_SECRETS[key]]),
  );
  return {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3100',
    DATABASE_URL:
      'postgresql://postgres:postgres@127.0.0.1:5432/protohub',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3100',
    STORAGE_ROOT: '~/protohub-storage',
    SERVE_STATIC: 'node',
    ...secrets,
    ...overrides,
  };
}

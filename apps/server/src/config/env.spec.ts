import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { deriveCookieSecure, EnvConfigError, expandUserPath, parseEnv } from './env';
import { baseEnvRaw, TEST_SECRETS } from '../testing/env.fixture';

describe('parseEnv：启动前必须把配置钉死', () => {
  it('合法的开发配置会被归一化成分组视图', () => {
    const env = parseEnv(baseEnvRaw());

    expect(env.http).toEqual({
      host: '127.0.0.1',
      port: 3100,
      publicBaseUrl: 'http://127.0.0.1:3100',
    });
    expect(env.storage.root).toBe(`${homedir()}/protohub-storage`);
    expect(env.storage.subdirs).toEqual([
      'tmp',
      'releases',
      'manifests',
      'trash',
    ]);
    expect(env.secrets).toEqual({
      jwtAccess: TEST_SECRETS.JWT_ACCESS_SECRET,
      jwtRefresh: TEST_SECRETS.JWT_REFRESH_SECRET,
      sessionCookie: TEST_SECRETS.SESSION_COOKIE_SECRET,
      accessToken: TEST_SECRETS.ACCESS_TOKEN_SECRET,
    });
    expect(env.serveStatic).toBe('node');
    expect(env.access.checkAllowCidrs).toEqual(['127.0.0.1/32']);
  });

  it('PUBLIC_BASE_URL 结尾多余的斜杠会被去掉', () => {
    const env = parseEnv(baseEnvRaw({ PUBLIC_BASE_URL: 'https://proto.example.com//' }));
    expect(env.http.publicBaseUrl).toBe('https://proto.example.com');
  });

  it('缺任何一个密钥都会拒绝启动，并在消息里点名是哪个', () => {
    const withoutRefresh = baseEnvRaw();
    delete withoutRefresh.JWT_REFRESH_SECRET;

    expect(() => parseEnv(withoutRefresh)).toThrowError(EnvConfigError);
    try {
      parseEnv(withoutRefresh);
      expect.unreachable('缺失密钥时不应该返回成功');
    } catch (caught) {
      expect(caught).toBeInstanceOf(EnvConfigError);
      const message = (caught as EnvConfigError).message;
      expect(message).toContain('JWT_REFRESH_SECRET');
      expect(message).toContain('openssl rand -base64 48');
    }
  });

  it('密钥短得像示例值也会被拒', () => {
    expect(() =>
      parseEnv(baseEnvRaw({ ACCESS_TOKEN_SECRET: 'short-secret' })),
    ).toThrowError(/ACCESS_TOKEN_SECRET/);
  });

  it('四个密钥两两不同：撞了就报出是哪两个', () => {
    const duplicated = baseEnvRaw({
      SESSION_COOKIE_SECRET: TEST_SECRETS.JWT_ACCESS_SECRET,
    });

    try {
      parseEnv(duplicated);
      expect.unreachable('重复密钥不应该通过校验');
    } catch (caught) {
      expect(caught).toBeInstanceOf(EnvConfigError);
      const problems = (caught as EnvConfigError).problems;
      expect(problems.some((p) => p.includes('SESSION_COOKIE_SECRET'))).toBe(true);
      expect(
        problems.some(
          (p) =>
            p.includes('SESSION_COOKIE_SECRET') &&
            p.includes('JWT_ACCESS_SECRET'),
        ),
      ).toBe(true);
    }
  });

  it('HOST 填 localhost 会被拒（只允许回环 IP）', () => {
    expect(() => parseEnv(baseEnvRaw({ HOST: 'localhost' }))).toThrowError(
      /HOST 不能填 localhost/,
    );
  });

  it('DATABASE_URL 与 SERVE_STATIC 的形状也会被校验', () => {
    expect(() =>
      parseEnv(baseEnvRaw({ DATABASE_URL: 'mysql://127.0.0.1:3306/x' })),
    ).toThrowError(/DATABASE_URL/);
    expect(() => parseEnv(baseEnvRaw({ SERVE_STATIC: 'caddy' }))).toThrowError(
      /SERVE_STATIC/,
    );
  });
});

describe('Cookie Secure 推导（迭代实施计划 §3.3 第一条差异）', () => {
  it('开发环境不加 Secure，否则 http 下浏览器根本不存 Cookie', () => {
    expect(deriveCookieSecure('development')).toBe(false);
    expect(deriveCookieSecure('test')).toBe(false);
    expect(parseEnv(baseEnvRaw()).cookie.secure).toBe(false);
  });

  it('生产环境必须是 Secure', () => {
    expect(deriveCookieSecure('production')).toBe(true);
    expect(
      parseEnv(baseEnvRaw({ NODE_ENV: 'production' })).cookie.secure,
    ).toBe(true);
  });
});

describe('expandUserPath', () => {
  it('支持 ~ 与 ~/', () => {
    expect(expandUserPath('~')).toBe(homedir());
    expect(expandUserPath('~/protohub-storage')).toBe(
      `${homedir()}/protohub-storage`,
    );
    expect(expandUserPath('/srv/storage')).toBe('/srv/storage');
  });
});

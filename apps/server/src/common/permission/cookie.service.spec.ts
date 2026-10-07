import { describe, expect, it } from 'vitest';

import { fakeAppEnv } from '../../testing/app-env.fixture';
import {
  CookieService,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_PATH,
  type CookieReplyWriter,
} from './cookie.service';

interface ReplyCapture {
  readonly calls: (string | readonly string[])[];
  readonly writer: CookieReplyWriter;
}

/** 只要 header() 这一个能力：Fastify 的 reply 结构上就是这么用的。 */
function createWriter(): ReplyCapture {
  const calls: (string | readonly string[])[] = [];
  const writer: CookieReplyWriter = {
    header(name: string, value: string | readonly string[]): unknown {
      calls.push(name === 'set-cookie' ? value : `${name}:${String(value)}`);
      return writer;
    },
  };
  return { calls, writer };
}

function service(nodeEnv = 'development'): CookieService {
  return new CookieService(fakeAppEnv({ NODE_ENV: nodeEnv }));
}

/** 7d / 2h：与 env 默认值一致（TTL 本身由 jwt/session 两个 spec 验配置层）。 */
const REFRESH_MAX_AGE = 604_800;
const SESSION_MAX_AGE = 7_200;

function issued(nodeEnv?: string): string[] {
  const { writer, calls } = createWriter();
  service(nodeEnv).issueAuthCookies(writer, {
    refreshToken: 'refresh.opaque.value',
    sessionToken: 'v1.7.0.1700000000000.sig',
    refreshMaxAgeSeconds: REFRESH_MAX_AGE,
    sessionMaxAgeSeconds: SESSION_MAX_AGE,
  });
  expect(calls).toHaveLength(1);
  const value = calls[0];
  expect(Array.isArray(value)).toBe(true);
  return (value as readonly string[]).map(String);
}

describe('CookieService（权限模型设计 §5.1 双 Cookie）', () => {
  it('下发两个 Cookie：一次 header() 调用里传数组，Fastify 才不会覆盖', () => {
    const cookies = issued();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]?.startsWith(`${REFRESH_COOKIE_NAME}=`)).toBe(true);
    expect(cookies[1]?.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  });

  it('refresh 限到 /api/auth，会话 Cookie 全站；两个都是 HttpOnly + SameSite=Lax', () => {
    const [refresh, session] = issued();
    expect(refresh).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('SameSite=Lax');
    expect(REFRESH_COOKIE_PATH).toBe('/api/auth');
    expect(session).toContain(`Path=${SESSION_COOKIE_PATH}`);
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
  });

  it('Max-Age 用调用方传入的秒数（7d / 2h），不做本地默认值', () => {
    const [refresh, session] = issued();
    expect(refresh).toContain(`Max-Age=${REFRESH_MAX_AGE}`);
    expect(session).toContain(`Max-Age=${SESSION_MAX_AGE}`);
  });

  it('Secure 只在 NODE_ENV=production 出现：开发跑 http，带 Secure 浏览器根本不存', () => {
    expect(issued('development')[0]).not.toContain('Secure');
    expect(issued('test')[1]).not.toContain('Secure');
    const [productionRefresh, productionSession] = issued('production');
    expect(productionRefresh).toContain('Secure');
    expect(productionSession).toContain('Secure');
  });

  it('logout 清除：同名同 Path + Max-Age=0，否则浏览器删不掉', () => {
    const { writer, calls } = createWriter();
    service().clearAuthCookies(writer);
    expect(calls).toHaveLength(1);
    const cleared = (calls[0] as readonly string[]).map(String);
    expect(cleared).toHaveLength(2);
    expect(cleared[0]?.startsWith(`${REFRESH_COOKIE_NAME}=;`)).toBe(true);
    expect(cleared[0]).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(cleared[0]).toContain('Max-Age=0');
    expect(cleared[1]?.startsWith(`${SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(cleared[1]).toContain(`Path=${SESSION_COOKIE_PATH}`);
    expect(cleared[1]).toContain('Max-Age=0');
  });

  it('read() 能从 cookie 头里取值，名字前缀不误命中', () => {
    const cookies = service();
    const request = {
      headers: {
        cookie: `other=1; ${REFRESH_COOKIE_NAME}=abc.def; ${SESSION_COOKIE_NAME}=v1.7.0.9.sig`,
      },
    };
    expect(cookies.read(request, REFRESH_COOKIE_NAME)).toBe('abc.def');
    expect(cookies.read(request, SESSION_COOKIE_NAME)).toBe('v1.7.0.9.sig');
    expect(cookies.read(request, 'other')).toBe('1');
    // 前缀相同的别的 Cookie 不能被当成目标值（历史上用 startsWith 匹配就会踩这个坑）。
    expect(cookies.read({ headers: { cookie: 'proto_refresh_v2=x' } }, REFRESH_COOKIE_NAME)).toBeUndefined();
    expect(cookies.read({ headers: {} }, REFRESH_COOKIE_NAME)).toBeUndefined();
    expect(cookies.read({}, REFRESH_COOKIE_NAME)).toBeUndefined();
    // 数组形态的头（某些代理会把同名头收成数组）。
    expect(
      cookies.read({ headers: { cookie: [`a=b`, `${SESSION_COOKIE_NAME}=s`] } }, SESSION_COOKIE_NAME),
    ).toBe('s');
  });
});

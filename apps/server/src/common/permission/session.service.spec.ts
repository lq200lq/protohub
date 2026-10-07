import { describe, expect, it } from 'vitest';

import { fakeAppEnv } from '../../testing/app-env.fixture';
import { parseDurationSeconds } from './duration';
import { SessionService } from './session.service';

const NOW = 1_700_000_000_000;

function service(refreshTokenTtl = '7d'): SessionService {
  return new SessionService(
    fakeAppEnv({ NODE_ENV: 'test', REFRESH_TOKEN_TTL: refreshTokenTtl }),
  );
}

describe('SessionService（proto_sess：HMAC 签名的 v1.{userId}.{tv}.{exp}.{sig}）', () => {
  it('签出来的载荷是 5 段且带 v1 前缀，token_version 编在里面', () => {
    const token = service().issue('42', 3, NOW);
    const parts = token.split('.');
    expect(parts).toHaveLength(5);
    expect(parts.slice(0, 4)).toEqual(['v1', '42', '3', String(NOW / 1000 + 604_800)]);
  });

  it('验签回来的就是签发时的三要素（M4 的 /access/check 只靠这个认身份）', () => {
    const sessions = service();
    const token = sessions.issue('42', 3, NOW);
    expect(sessions.verify(token, NOW)).toEqual({
      userId: '42',
      tokenVersion: 3,
      expiresAt: NOW / 1000 + 604_800,
    });
  });

  it('篡改 userId 或 tokenVersion 一律验签失败（防"把 viewer 改成 super_admin"）', () => {
    const sessions = service();
    const token = sessions.issue('42', 3, NOW);
    const [_prefix, userId, tv, exp, sig] = token.split('.');
    const forged = (overrideUserId: string, overrideTv: string): string =>
      `v1.${overrideUserId}.${overrideTv}.${exp}.${sig}`;
    expect(userId).toBe('42');
    expect(tv).toBe('3');
    expect(sessions.verify(forged('1', '3'), NOW)).toBeNull();
    expect(sessions.verify(forged('42', '9'), NOW)).toBeNull();
    // 换掉签名段也不行。
    expect(sessions.verify(`v1.42.3.${exp}.${sig?.slice(0, -2)}xx`, NOW)).toBeNull();
  });

  it('过期返回 null（和验签失败同一个结果，不给探测留差异）', () => {
    const sessions = service('2h');
    const token = sessions.issue('42', 0, NOW);
    expect(parseDurationSeconds('2h')).toBe(7_200);
    expect(sessions.verify(token, NOW + 7_199_000)).not.toBeNull();
    expect(sessions.verify(token, NOW + 7_200_000)).toBeNull();
  });

  it('换密钥后旧 Cookie 全部失效（SESSION_COOKIE_SECRET 与其他密钥必须互不复用）', () => {
    const other = new SessionService(
      fakeAppEnv({
        NODE_ENV: 'test',
        SESSION_COOKIE_SECRET: 'another-session-cookie-secret-0123456789abcdef',
      }),
    );
    expect(other.verify(service().issue('42', 3, NOW), NOW)).toBeNull();
  });

  it('畸形输入不抛异常：长度不对 / 前缀不对 / 非数字段 / 空值都当未登录', () => {
    const sessions = service();
    for (const raw of [
      undefined,
      '',
      'v1.42.3',
      `v1.42.3.${NOW / 1000 + 60}.sig.extra`,
      `v2.42.3.${NOW / 1000 + 60}.sig`,
      `v1.abc.3.${NOW / 1000 + 60}.sig`,
      `v1.42.-1.${NOW / 1000 + 60}.sig`,
      `v1.42.3.notanumber.sig`,
    ]) {
      expect(sessions.verify(raw, NOW)).toBeNull();
    }
  });

  it('ttlSeconds 跟随 REFRESH_TOKEN_TTL（两个 Cookie 生命周期一致才不会出现半新半旧）', () => {
    expect(service('7d').ttlSeconds).toBe(604_800);
    expect(service('12h').ttlSeconds).toBe(43_200);
  });
});

describe('parseDurationSeconds', () => {
  it('支持 s/m/h/d 并拒绝非法值', () => {
    expect(parseDurationSeconds('30s')).toBe(30);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7_200);
    expect(parseDurationSeconds('7d')).toBe(604_800);
    for (const invalid of ['2', '2x', '', 'h2', '-1h', '1.5h']) {
      expect(() => parseDurationSeconds(invalid)).toThrowError(/时长/u);
    }
  });
});

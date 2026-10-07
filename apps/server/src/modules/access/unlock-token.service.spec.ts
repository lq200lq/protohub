import { describe, expect, it } from 'vitest';

import { fakeAppEnv } from '../../testing/app-env.fixture';
import { UnlockTokenService } from './unlock-token.service';

/**
 * M4-T8：解锁令牌 `v1.{policyVersion}.{exp}.{sig}`，签名绑定两级编码（机制 §5.2）。
 * NOW 固定成一个整秒的时间戳，免得断言里出现毫秒取整的抖动。
 */
const NOW = 1_700_000_000_000;

const TARGET = { policyVersion: 3, projectCode: 'crm', prototypeCode: 'crm-p01' };

function service(overrides: Record<string, string> = {}): UnlockTokenService {
  return new UnlockTokenService(
    fakeAppEnv({ NODE_ENV: 'test', UNLOCK_TOKEN_TTL: '24h', ...overrides }),
  );
}

describe('UnlockTokenService（proto_access_p{原型ID}）', () => {
  it('签出来是 4 段、带 v1 前缀，段 2 就是该原型的 policy_version', () => {
    const parts = service().issue(TARGET, NOW).split('.');
    expect(parts).toHaveLength(4);
    expect(parts.slice(0, 3)).toEqual(['v1', '3', String(NOW / 1000 + 86_400)]);
  });

  it('正确编码 + 正确 policy_version → 验签通过', () => {
    const tokens = service();
    expect(tokens.verify(tokens.issue(TARGET, NOW), TARGET, NOW)).toBe(true);
  });

  it('policy_version 一变，旧 Cookie 立即失效（这是 D-07"不用维护已签发令牌表"的那条承诺）', () => {
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    expect(tokens.verify(token, { ...TARGET, policyVersion: 4 }, NOW)).toBe(false);
    expect(tokens.verify(token, { ...TARGET, policyVersion: 2 }, NOW)).toBe(false);
  });

  it('policy_version 本身也在签名里：载荷里的号被改成新值、签名沿用旧的就过不了', () => {
    // 改口令后 policy_version 3→4。上一条只挡"令牌没动"的情形；这一条挡的是
    // 攻击者把载荷里的 3 改成 4、签名照抄——若 policy_version 不参与签名，旧 Cookie
    // 就能被改号复活，D-07 的安全承诺失效（计划 §6.4 N7）。
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    const [prefix, , exp, sig] = token.split('.') as [string, string, string, string];
    expect(
      tokens.verify(`${prefix}.4.${exp}.${sig}`, { ...TARGET, policyVersion: 4 }, NOW),
    ).toBe(false);
  });

  it('换一个原型/项目就过不了：签名把两级编码一起算进去了', () => {
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    expect(
      tokens.verify(token, { ...TARGET, prototypeCode: 'crm-p02' }, NOW),
    ).toBe(false);
    expect(
      tokens.verify(token, { ...TARGET, projectCode: 'crm-copy' }, NOW),
    ).toBe(false);
  });

  it('同项目下另一个原型的 policy_version 相同也不通用（编码参与了签名）', () => {
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    expect(
      tokens.verify(token, { ...TARGET, prototypeCode: 'crm-p03' }, NOW),
    ).toBe(false);
  });

  it('过期即失效，且"刚好到点"与"到点前一秒"分得清', () => {
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    expect(tokens.verify(token, TARGET, NOW + 86_399_000)).toBe(true);
    expect(tokens.verify(token, TARGET, NOW + 86_400_000)).toBe(false);
  });

  it('篡改任意一段或换密钥都验不过；畸形输入不抛异常', () => {
    const tokens = service();
    const token = tokens.issue(TARGET, NOW);
    const [prefix, policyVersion, exp, sig] = token.split('.') as [
      string,
      string,
      string,
      string,
    ];
    expect(prefix).toBe('v1');
    expect(tokens.verify(`v1.99.${exp}.${sig}`, TARGET, NOW)).toBe(false);
    expect(tokens.verify(`v1.${policyVersion}.${Number(exp) + 3600}.${sig}`, TARGET, NOW)).toBe(false);
    expect(tokens.verify(`v1.${policyVersion}.${exp}.${sig.slice(0, -2)}AA`, TARGET, NOW)).toBe(false);

    const other = new UnlockTokenService(
      fakeAppEnv({
        NODE_ENV: 'test',
        ACCESS_TOKEN_SECRET: 'another-access-token-secret-0123456789abcdef',
        UNLOCK_TOKEN_TTL: '24h',
      }),
    );
    expect(other.verify(token, TARGET, NOW)).toBe(false);

    for (const malformed of [undefined, '', 'v1.3', 'v2.3.4.5', 'v1.abc.4.sig', 'v1.3.notanumber.sig']) {
      expect(tokens.verify(malformed, TARGET, NOW)).toBe(false);
    }
  });

  it('ttlSeconds 跟 UNLOCK_TOKEN_TTL，Cookie 的 Max-Age 与令牌里的 exp 必须是同一个数', () => {
    expect(service().ttlSeconds).toBe(86_400);
    expect(service({ UNLOCK_TOKEN_TTL: '12h' }).ttlSeconds).toBe(43_200);
    const tokens = service({ UNLOCK_TOKEN_TTL: '12h' });
    const [prefix, , exp] = tokens.issue(TARGET, NOW).split('.') as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe('v1');
    expect(Number(exp) - NOW / 1000).toBe(tokens.ttlSeconds);
  });
});

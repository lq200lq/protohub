import { describe, expect, it } from 'vitest';

import {
  buildChangeDiff,
  buildSetDiff,
  isSensitiveKey,
  omitSensitiveKeys,
  passwordChangedDetail,
  redactAuditValue,
  REDACTED_PLACEHOLDER,
  toAuditValue,
} from './audit-diff';

/**
 * 审计差异与脱敏单测（数据库设计 §4.1.9 的三条红线 + 计划 §3.7"审计必须脱敏"）。
 * 这里出的错不会有任何测试以外的信号——日志里的秘密一旦被检索到就已经泄露了。
 */

describe('敏感字段名识别', () => {
  it('大小写与下划线变体都算命中', () => {
    for (const key of ['password', 'passwordHash', 'PASSWORD_HASH', 'refreshToken', 'accessToken', 'client_secret', 'cookie', 'authorization']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
  });

  it('普通业务字段不误伤', () => {
    for (const key of ['name', 'code', 'accessMode', 'sort', 'status']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('redactAuditValue', () => {
  it('整体替换而不是部分打码（部分打码仍会露出哈希前缀）', () => {
    expect(redactAuditValue({ passwordHash: '$argon2id$v=19$m=65536,t=3' })).toEqual({
      passwordHash: REDACTED_PLACEHOLDER,
    });
  });

  it('递归进数组与嵌套对象', () => {
    expect(
      redactAuditValue({ members: [{ token: 'abc', name: '张三' }], snapshot: { password: 'x' } }),
    ).toEqual({
      members: [{ name: '张三', token: REDACTED_PLACEHOLDER }],
      snapshot: { password: REDACTED_PLACEHOLDER },
    });
  });

  it('布尔值例外：§4.1.9 唯一认可的 {password_changed:true} 本身不含秘密，打成 [REDACTED] 会把"改过密码"这个事实抹掉', () => {
    const detail = { ...buildChangeDiff({ accessMode: 'public' }, { accessMode: 'password' })! };
    expect(redactAuditValue({ ...detail, ...passwordChangedDetail() })).toEqual({
      after: { accessMode: 'password' },
      before: { accessMode: 'public' },
      password_changed: true,
    });
  });

  it('字符串与数字照常屏蔽，哪怕值是 true 的同名键也一样处理', () => {
    expect(redactAuditValue({ password: 'true', refreshToken: '1' })).toEqual({
      password: REDACTED_PLACEHOLDER,
      refreshToken: REDACTED_PLACEHOLDER,
    });
  });
});

describe('buildChangeDiff', () => {
  it('只记变化了的字段，未变的不进 detail（日志是给人查的，不是镜像表）', () => {
    expect(
      buildChangeDiff(
        { accessMode: 'public', description: '同', name: '旧名' },
        { accessMode: 'public', description: '同', name: '新名' },
      ),
    ).toEqual({ after: { name: '新名' }, before: { name: '旧名' } });
  });

  it('没变更返回 null，调用方据此跳过 detail', () => {
    expect(buildChangeDiff({ name: 'a' }, { name: 'a' })).toBeNull();
  });

  it('Date 与它的 ISO 串视为同一个值（不因归一化误报变更）', () => {
    const at = new Date('2026-10-06T10:00:00.000Z');
    expect(buildChangeDiff({ publishedAt: at }, { publishedAt: at.toISOString() })).toBeNull();
  });

  it('变更项的键本身是敏感字段时，两侧都被屏蔽', () => {
    expect(buildChangeDiff({ passwordHash: 'old' }, { passwordHash: 'new' })).toEqual({
      after: { passwordHash: REDACTED_PLACEHOLDER },
      before: { passwordHash: REDACTED_PLACEHOLDER },
    });
  });
});

describe('buildSetDiff 与快照', () => {
  it('集合类授权变更记增删 + 两侧全集', () => {
    expect(buildSetDiff(['a', 'b'], ['b', 'c'])).toEqual({
      added: ['c'],
      after: ['b', 'c'],
      before: ['a', 'b'],
      removed: ['a'],
    });
  });

  it('删除快照里敏感字段名照样过滤', () => {
    expect(omitSensitiveKeys({ nickname: '李四', passwordHash: 'x', username: 'lisi' })).toEqual({
      nickname: '李四',
      passwordHash: REDACTED_PLACEHOLDER,
      username: 'lisi',
    });
  });

  it('布尔值例外与 redactAuditValue 同判：{password_changed:true} 过了 omitSensitiveKeys 也还在', () => {
    expect(omitSensitiveKeys({ password_changed: true, username: 'lisi' })).toEqual({
      password_changed: true,
      username: 'lisi',
    });
  });

  it('toAuditValue 把 Date 归一成 ISO 串、把不可入 JSON 的值收敛掉', () => {
    expect(toAuditValue(new Date('2026-10-06T10:00:00.000Z'))).toBe('2026-10-06T10:00:00.000Z');
    expect(() => JSON.stringify(toAuditValue(() => 1))).not.toThrow();
  });
});

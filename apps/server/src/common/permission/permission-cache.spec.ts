import { describe, expect, it } from 'vitest';

import { TtlLruCache } from './permission-cache';

/** 假时钟：TTL 与淘汰必须能确定性测试，不能真的等 30 秒。 */
function createClock(start = 1_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance: (ms: number): number => {
      current += ms;
      return current;
    },
  };
}

describe('TtlLruCache（权限模型设计 §8.2 的 30 秒缓存底座）', () => {
  it('TTL 内命中、到期后 miss 并把条目清掉', () => {
    const clock = createClock();
    const cache = new TtlLruCache<string>(30_000, 10, clock.now);
    cache.set('7', 'proto:release:list');
    expect(cache.get('7')).toBe('proto:release:list');
    clock.advance(29_999);
    expect(cache.get('7')).toBe('proto:release:list');
    clock.advance(1); // 正好 30_000：expiresAt <= now 视为过期
    expect(cache.get('7')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('过期后重新 set 会续命（撤销后 30 秒内自然收敛）', () => {
    const clock = createClock();
    const cache = new TtlLruCache<number>(1_000, 10, clock.now);
    cache.set('a', 1);
    clock.advance(1_500);
    cache.set('a', 2);
    clock.advance(999);
    expect(cache.get('a')).toBe(2);
    clock.advance(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('超上限按 LRU 淘汰最久未使用的，读一次即可续命', () => {
    const clock = createClock();
    const cache = new TtlLruCache<number>(60_000, 2, clock.now);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // a 变成最近使用，b 成为最老
    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('delete/deleteMany/clear 供主动失效用（改角色权限、改用户角色、禁用用户）', () => {
    const clock = createClock();
    const cache = new TtlLruCache<number>(60_000, 10, clock.now);
    cache.set('1', 1);
    cache.set('2', 2);
    cache.set('3', 3);
    cache.delete('1');
    cache.deleteMany(['2', '不存在']);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('空 Set 也算命中：权限为 0 的用户不该每个请求都回库', () => {
    const clock = createClock();
    const cache = new TtlLruCache<ReadonlySet<string>>(60_000, 10, clock.now);
    const empty = new Set<string>();
    cache.set('9', empty);
    expect(cache.get('9')).toBe(empty);
  });

  it('非法构造参数直接抛 RangeError（配 0/负数会让缓存语义整体失效）', () => {
    expect(() => new TtlLruCache<number>(0)).toThrow(RangeError);
    expect(() => new TtlLruCache<number>(-1)).toThrow(RangeError);
    expect(() => new TtlLruCache<number>(1_000, 0)).toThrow(RangeError);
  });
});

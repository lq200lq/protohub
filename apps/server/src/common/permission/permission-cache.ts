/**
 * 权限码缓存（权限模型设计 §8.2）。
 *
 * 单独拆成一个不带 Nest/Prisma 依赖的类，是为了让 TTL 与淘汰行为可以用假时钟确定性测试
 * ——真实 30 秒等待不适合放进单测。
 */

interface CacheEntry<TValue> {
  value: TValue;
  expiresAt: number;
}

export class TtlLruCache<TValue> {
  /** Map 的迭代顺序 = 插入顺序，读取时删后重插即可当作"最近使用"用。 */
  private readonly entries = new Map<string, CacheEntry<TValue>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (ttlMs <= 0) {
      throw new RangeError('TtlLruCache: ttlMs 必须为正数');
    }
    if (maxEntries <= 0) {
      throw new RangeError('TtlLruCache: maxEntries 必须为正数');
    }
  }

  get(key: string): TValue | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: TValue): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  deleteMany(keys: readonly string[]): void {
    for (const key of keys) {
      this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

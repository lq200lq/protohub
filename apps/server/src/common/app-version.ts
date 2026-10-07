import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJsonShape {
  readonly name?: unknown;
  readonly version?: unknown;
}

let cached: string | undefined;

/**
 * `/api/health` 需要版本号（后端接口设计.md §9.4）。不 import package.json：
 * tsc 不会把 json 拷进 dist，运行时路径会指向不存在的位置；改成向上找一次真实文件，
 * src 与 dist 两种布局都能命中，取不到就退回 `0.0.0`（健康检查绝不该因为版本而失败）。
 */
export function readAppVersion(): string {
  if (cached !== undefined) {
    return cached;
  }
  const candidates = [
    join(__dirname, '..', 'package.json'),
    join(__dirname, '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(
        readFileSync(candidate, 'utf8'),
      ) as PackageJsonShape;
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // 继续试下一个候选路径
    }
  }
  cached = '0.0.0';
  return cached;
}

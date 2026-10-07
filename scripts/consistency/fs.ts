import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { ROOT } from './types.ts';

/** 需要扫描的源码根目录（不存在就跳过，避免 M0 阶段空目录报错）。 */
export const SERVER_SRC = join(ROOT, 'apps/server/src');
export const ADMIN_SRC = join(ROOT, 'apps/admin/src');
export const ADMIN_VIEWS = join(ROOT, 'apps/admin/src/views');
export const MIGRATIONS_DIR = join(ROOT, 'packages/db/prisma/migrations');

const SOURCE_EXTENSIONS = new Set(['.ts', '.vue']);

/** 递归列出待扫描源文件（跳过依赖与产物目录）。 */
export function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  walk(dir, found);
  return found.sort();
}

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在：视为 0 个文件，由规则自己决定怎么报告
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIndex = entry.name.lastIndexOf('.');
    const ext = dotIndex === -1 ? '' : entry.name.slice(dotIndex);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
}

function isIgnoredDir(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'coverage' ||
    name === '.turbo'
  );
}

/** 相对仓库根的路径：报错信息里用短路径，可直接复制去打开。 */
export function repoRelative(absolutePath: string): string {
  return relative(ROOT, absolutePath).split(sep).join('/');
}

export function isFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** 文件按行定位：返回 1-based 行号（找不到返回 1，只影响展示不影响判定）。 */
export function lineIndexOf(
  content: string,
  matchIndex: number,
): number {
  let line = 1;
  for (let i = 0; i < matchIndex && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

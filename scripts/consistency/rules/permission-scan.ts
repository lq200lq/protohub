/**
 * 权限码源码扫描的唯一实现（R2 / R5 / R7 共用；计划 §3.7「两处以上用到的能力收敛为一个通用件」）。
 *
 * 计划明确要求"正则扫源码"，不引 TS 编译器 API：码写错不报错、只会"按钮不见了"或"接口不设防"，
 * 所以宁可要一个朴素但可读的扫描器，也不要一套只有改它的人才懂的 AST 管线。
 */

export interface CodeHit {
  code: string;
  /** 命中处的字符偏移，调用方据此换算 file:line */
  index: number;
}

const DECORATOR = /@RequirePermission\b/g;
const STRING_LITERAL = /(['"`])([^'"`\n]*)\1/g;

/** 配平括号取出装饰器实参整段；括号没配平返回 null（语法问题交给 tsc） */
function decoratorArgs(
  content: string,
  openParenIndex: number,
): null | string {
  let depth = 0;
  for (let i = openParenIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return content.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

/**
 * `@RequirePermission('a', 'b')` 里的每个码。支持跨行与一个装饰器写多个码（OR 语义），
 * 也容忍 `@RequirePermission ()` 这种带空白的写法；非调用形式（注释/文档）跳过。
 */
export function requirePermissionHits(content: string): CodeHit[] {
  const hits: CodeHit[] = [];
  for (const match of content.matchAll(DECORATOR)) {
    const after = content.slice(match.index + match[0].length);
    const parenOffset = after.search(/[^\s]/);
    if (parenOffset === -1 || after[parenOffset] !== '(') continue;
    const openIndex = match.index + match[0].length + parenOffset;
    const args = decoratorArgs(content, openIndex);
    if (args === null) continue;

    for (const strMatch of args.matchAll(STRING_LITERAL)) {
      const code = strMatch[2];
      if (code.length === 0) continue;
      hits.push({
        code,
        index:
          openIndex + (strMatch.index ?? 0) + (strMatch[1] ?? '').length,
      });
    }
  }
  return hits;
}

const PERMISSION_SHAPE = /\b(proto|system|dashboard):[a-z0-9]+:[a-z0-9]+\b/g;

/**
 * 源码里被引号包住的权限码字面量（`hasAccessByCodes(['x'])`、`v-access:code="['x']"` 等）。
 * 只认引号包住的：注释、路由 path、i18n key 里撞上同样形状的字符串一律跳过。
 */
export function permissionLiteralHits(content: string): CodeHit[] {
  const hits: CodeHit[] = [];
  for (const match of content.matchAll(PERMISSION_SHAPE)) {
    const code = match[0];
    const start = match.index ?? 0;
    const before = content[start - 1];
    const after = content[start + code.length];
    const quoted =
      (before === `'` && after === `'`) ||
      (before === `"` && after === `"`) ||
      (before === '`' && after === '`');
    if (!quoted) continue;
    hits.push({ code, index: start });
  }
  return hits;
}

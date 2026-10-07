import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as cheerio from 'cheerio';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import {
  UPLOAD_WARNING_CODES,
  type UploadTaskWarning,
  type UploadWarningCode,
} from '@protohub/shared';

import { REWRITE_MAX_FILE_BYTES } from '../../../config/constants';
import { formatBytes } from './errors';
import type { ExtractedFile } from './extract';

/**
 * 根绝对路径改写（机制 §2.6，决策 D-11）。
 *
 * 要解决的问题写在 §2.6 第一句：原型里 `<script src="/assets/app.js">` 这类根绝对路径，
 * 挂到 `/p/{项目码}/{原型码}/` 下会被解析成站点根 → 404 → 白屏。这是"原型打开是白屏"的第一大原因。
 *
 * 三条硬性约束在这里是**代码结构**，不是注释：
 * 1. **不碰 JS**：`HTML_SUFFIXES`/`CSS_SUFFIXES` 之外的文件根本不进解析器。JS 里的 `fetch('/api/x')`
 *    是原型的业务行为，正则改写会误伤，而且把"这个原型依赖后端"这件事掩盖掉了。
 * 2. **含 `<base href>` 就不改**：检测到即记 `BASE_TAG_FOUND` 并跳过该文件（base 改变相对基准，
 *    再叠前缀可能算出错误路径）。只跳这一份文件——CSS 的 url() 基准是 CSS 文件自己，不受 HTML 的 base 影响。
 * 3. **失败不阻断发布**：解析异常记 `REWRITE_SKIPPED` 然后继续，原文件保持原样。
 *    这条只兜**内容**错误；读盘/写盘错误（文件不见、磁盘满）一律上抛——把盘出的问题说成
 *    "已按原样发布"会让一个坏版本带病上线，而 §8 本来就为磁盘满留了 `UPLOAD_DISK_FULL` 这个码。
 *
 * 另有一条实现层的自律：**一处都没改就不回写**。序列化不是无损的：实测 cheerio 会把
 * `<!doctype html>` 规范成 `<!DOCTYPE html>`、把属性值里的裸 `&` 编成 `&amp;`（浏览器解析结果相同，
 * 但发出的字节变了），遇到畸形 HTML 还会顺手补全标签。对"本来就没有根绝对路径"的包来说
 * 这些都是纯风险（约束 3 的精神：宁可原样发出），所以只在 changed > 0 时写盘。
 */

/** 只改这两类；后缀大小写不敏感（Windows 导出常见 INDEX.HTM）。 */
const HTML_SUFFIXES: readonly string[] = ['.html', '.htm'];
const CSS_SUFFIXES: readonly string[] = ['.css'];

/** §2.6 表格里点名的属性。`srcset` 是候选列表，格式不同，单独处理。 */
const SINGLE_VALUE_ATTRS: readonly string[] = ['src', 'href', 'poster', 'data-src'];
const SRCSET_ATTR = 'srcset';

export interface RewriteInput {
  /** 解压清单里的产物（脱壳后的最终路径） */
  readonly files: readonly ExtractedFile[];
  /** 前缀由**该原型的**两级编码拼成，即 `prototypeAccessPath(projectCode, code)`（§2.6 末段）。 */
  readonly prefixPath: string;
  readonly workDir: string;
}

export interface RewriteOutcome {
  readonly css: number;
  readonly html: number;
  /** 发布报告里的逐条人话（`BASE_TAG_FOUND` / `REWRITE_SKIPPED` / `REWRITE_TOO_LARGE`），已按码聚合。 */
  readonly warnings: UploadTaskWarning[];
}

export async function rewriteRootAbsolutePaths(input: RewriteInput): Promise<RewriteOutcome> {
  const warnings = new WarningCollector();
  let html = 0;
  let css = 0;

  for (const file of input.files) {
    const abs = join(input.workDir, file.name);
    if (hasSuffix(file.name, HTML_SUFFIXES)) {
      html += await rewriteHtmlFile(abs, file.name, input.prefixPath, warnings);
    } else if (hasSuffix(file.name, CSS_SUFFIXES)) {
      css += await rewriteCssFile(abs, file.name, input.prefixPath, warnings);
    }
  }
  return { css, html, warnings: warnings.list() };
}

function hasSuffix(name: string, suffixes: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

async function rewriteHtmlFile(
  abs: string,
  name: string,
  prefixPath: string,
  warnings: WarningCollector,
): Promise<number> {
  if (await tooLarge(abs, name, warnings)) {
    return 0;
  }
  // 读盘在 try 之外：§2.6 约束 3 兜的是"内容改不动"，不是"盘出问题"。
  // 工作目录与清单对不上（文件不见）或写不进去（磁盘满）时，谎报成"已按原样发布"会让
  // 一个坏版本带病上线；这类错误直接上抛，由 Worker 按 §8 收敛成 UPLOAD_DISK_FULL。
  const original = await readFile(abs, 'utf8');
  let changed = 0;
  let rendered: null | string = null;
  try {
    // cheerio 1.2 的 HTML 解析器是 parse5（规范实现），文本与 `<script>`/`<style>` 原始内容、
    // 字符实体都按原样往返，实测无需任何选项（旧的 `decodeEntities` 在这里已不存在）。
    const $ = cheerio.load(original);
    if ($('base[href]').length > 0) {
      // 约束 2：整份不改，只报告。
      warnings.add(
        UPLOAD_WARNING_CODES.BASE_TAG_FOUND,
        `文件 "${name}" 含 <base href>，可能影响路径解析 — 建议移除 base 后重新导出`,
      );
    } else {
      for (const attr of SINGLE_VALUE_ATTRS) {
        $(`[${attr}]`).each((_index, element) => {
          const node = $(element);
          const value = node.attr(attr);
          if (value === undefined) {
            return;
          }
          const next = prefixIfRootAbsolute(value, prefixPath);
          if (next !== null) {
            node.attr(attr, next);
            changed += 1;
          }
        });
      }
      $(`[${SRCSET_ATTR}]`).each((_index, element) => {
        const node = $(element);
        const value = node.attr(SRCSET_ATTR);
        if (value === undefined) {
          return;
        }
        const rewritten = rewriteSrcset(value, prefixPath);
        if (rewritten.changed > 0) {
          node.attr(SRCSET_ATTR, rewritten.value);
          changed += rewritten.changed;
        }
      });
      if (changed > 0) {
        rendered = $.html();
      }
    }
  } catch (error: unknown) {
    // 约束 3：改不动就原样发出去——白屏看得见，人才会去查发布报告。
    warnings.add(
      UPLOAD_WARNING_CODES.REWRITE_SKIPPED,
      `文件 "${name}" 改写失败，已按原样发布：${reasonOf(error)}`,
    );
    return 0;
  }
  // 写盘也在 try 之外：见函数开头那条"内容错误 vs 盘错误"的分工。
  if (rendered !== null) {
    await writeFile(abs, rendered, 'utf8');
  }
  return changed;
}

async function rewriteCssFile(
  abs: string,
  name: string,
  prefixPath: string,
  warnings: WarningCollector,
): Promise<number> {
  if (await tooLarge(abs, name, warnings)) {
    return 0;
  }
  const original = await readFile(abs, 'utf8');
  let changed = 0;
  let rendered: null | string = null;
  try {
    const root = postcss.parse(original, { from: name });
    root.walkDecls((decl) => {
      const parsed = valueParser(decl.value);
      let touched = 0;
      parsed.walk((node) => {
        if (node.type !== 'function' || node.value.toLowerCase() !== 'url') {
          return;
        }
        touched += prefixUrlFunction(node, prefixPath);
      });
      if (touched > 0) {
        decl.value = parsed.toString();
        changed += touched;
      }
    });
    if (changed > 0) {
      rendered = root.toString();
    }
  } catch (error: unknown) {
    warnings.add(
      UPLOAD_WARNING_CODES.REWRITE_SKIPPED,
      `文件 "${name}" 改写失败，已按原样发布：${reasonOf(error)}`,
    );
    return 0;
  }
  if (rendered !== null) {
    await writeFile(abs, rendered, 'utf8');
  }
  return changed;
}

/**
 * §2.6 的性能保护：畸形大文件不进解析器。尺寸取磁盘实际值，不取清单声明值（改写会改变大小）。
 * 单独成条而不是混进 `REWRITE_SKIPPED`：这是"按规则跳过"，不是"出错了"，报告里的建议不一样。
 */
async function tooLarge(
  abs: string,
  name: string,
  warnings: WarningCollector,
): Promise<boolean> {
  const size = (await stat(abs)).size;
  if (size <= REWRITE_MAX_FILE_BYTES) {
    return false;
  }
  warnings.add(
    UPLOAD_WARNING_CODES.REWRITE_TOO_LARGE,
    `文件 "${name}" 超过 ${formatBytes(REWRITE_MAX_FILE_BYTES)}，已跳过改写`,
  );
  return true;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 只处理**以单个 `/` 开头**的值（§2.6 表格最后一列）。
 * `//cdn.example.com/x.js` 是协议相对外链、`data:`/`http(s):`/相对路径都是外链或本来就对，一律不动。
 * 返回 null 表示不改。
 */
export function prefixIfRootAbsolute(value: string, prefixPath: string): string | null {
  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  return `${prefixPath}${value}`;
}

/**
 * 改写一个 `url(...)` 函数节点，返回改动处数（0 或 1）。
 *
 * 载荷的形状取决于解析器走了哪条分支（实测 postcss-value-parser 只为小写 `url(` 开专用分支）：
 * - `url(/a.png)`、`url("/a.png")`：一个 word 或 string 节点，它的值就是整个路径；
 * - `URL(/a/b.png)`：函数名大写匹配不到专用分支，落进通用函数解析，没引号的路径被按 `/` 拆成
 *   `div('/') + word('a') + div('/') + word('b.png')`——任何一个子节点都不再等于"整个路径"。
 *
 * 所以判定不逐个子节点问（那样 `URL(/a.png)` 会看不见，白屏还不进报告），而是把载荷**还原成文本**、
 * 问过同一个 `prefixIfRootAbsolute`（§2.6 的口径全项目只有一处），再按形状写回：单节点直接换值，
 * 引号由 stringify 自己补；拆分形态只换开头那个 `/`——`prefixPath` 结尾没有 `/`，补上它就等于整段换掉。
 */
function prefixUrlFunction(node: UrlFunctionNode, prefixPath: string): number {
  const payload = node.nodes ?? [];
  if (payload.length === 0) {
    return 0;
  }
  const raw = payload.map((child) => child.value).join('');
  const next = prefixIfRootAbsolute(raw, prefixPath);
  const first = payload[0];
  if (next === null || first === undefined) {
    return 0;
  }
  first.value = payload.length === 1 ? next : `${prefixPath}/`;
  return 1;
}

/** `url()` 的函数节点：只依赖"有 nodes 载荷、载荷节点有可改的 value"这两点。 */
interface UrlFunctionNode {
  readonly nodes?: { value: string }[];
}

/** `srcset` 是逗号分隔的 `url [描述符]` 列表；只动每段第一部分，其余字节原样保留。 */
export function rewriteSrcset(
  value: string,
  prefixPath: string,
): { changed: number; value: string } {
  let changed = 0;
  const parts = value.split(',').map((part) => {
    const start = part.length - part.trimStart().length;
    const url = part.slice(start).split(/\s/u)[0] ?? '';
    const next = prefixIfRootAbsolute(url, prefixPath);
    if (next === null) {
      return part;
    }
    changed += 1;
    // 原位替换第一段 URL：分隔符、空白、描述符一个字节都不动。
    return `${part.slice(0, start)}${next}${part.slice(start + url.length)}`;
  });
  // split/join 是无损的，所以没改时结果必然等于原文；这里直接返回原值，省掉一次重新拼装。
  return changed === 0 ? { changed: 0, value } : { changed, value: parts.join(',') };
}

/**
 * 同一码的警告合并成一条（§2.6 的报告是给人读的）：一个包可能几十份 CSS 同时改不动，
 * 逐条记会把报告刷成噪声，而"这类问题共 N 处"才是有用信息。第一条的文件名留在正文里供定位。
 */
class WarningCollector {
  private readonly buckets: { code: UploadWarningCode; count: number; first: string }[] = [];

  add(code: UploadWarningCode, message: string): void {
    const existing = this.buckets.find((bucket) => bucket.code === code);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.buckets.push({ code, count: 1, first: message });
  }

  list(): UploadTaskWarning[] {
    return this.buckets.map((bucket) => ({
      code: bucket.code,
      ...(bucket.count > 1 ? { count: bucket.count } : {}),
      message:
        bucket.count > 1
          ? `${bucket.first}（同类共 ${String(bucket.count)} 处）`
          : bucket.first,
    }));
  }
}

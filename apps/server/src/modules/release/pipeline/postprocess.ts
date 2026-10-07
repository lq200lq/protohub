import { createHash } from 'node:crypto';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ERROR_CODES,
  UPLOAD_WARNING_CODES,
  type UploadTaskWarning,
} from '@protohub/shared';

import { uploadRejected, type UploadLimits } from './errors';
import type { ExtractedFile } from './extract';
import { sha256OfFile } from './hash';
import { rewriteRootAbsolutePaths } from './rewrite';
import { isIndexEntryName } from './validate';

/**
 * 后处理（机制 §2.1③ / §2.5 / §2.6 / §2.7）：在 `tmp/work-{taskId}/` 里把"解压出来的东西"
 * 变成"可以发布的东西"，顺序就是 §2.1③ 写的那条：脱壳 → 入口探测 → 路径改写 → 清单与指纹。
 *
 * 两处顺序是有原因的，不是随手排的：
 * - **改写要在指纹之前**：`content_hash` 要能回答"以后重传同一个内容会不会得到同一个版本"，
 *   所以它必须打在**最终发出去的那批字节**上；先算指纹再改写，同一个包两次发布可能算出不同值。
 * - **脱壳要在改写之前**：上提目录会改变所有产物的相对路径，改写后的路径与清单里的 `p` 才能对上。
 *
 * 与受理阶段的分工：`source_hash` 去重（§2.7）在受理时已经查过当前版本并返回
 * `UPLOAD_DUPLICATE_CONTENT`（见 `release.service.ts`），这里只负责产出 `content_hash`，
 * 不在两处各写一份判定。
 */

/** §2.7 manifest.files 的一行。键名照文档的短键，落 jsonb 与副本文件都用这一份。 */
export interface ManifestFile {
  readonly p: string;
  readonly sha256: string;
  readonly size: number;
}

/** §2.7 manifest.skipped 的一行：目前只有垃圾项过滤这一种跳过（§2.4）。 */
export interface ManifestSkipped {
  readonly p: string;
  readonly reason: 'junk';
}

/** `proto_release.manifest` 的形态（§2.7），同时原样写一份到 `manifests/{原型ID}/{版本ID}.json`。 */
export interface ReleaseManifest {
  readonly entry: string;
  readonly fileCount: number;
  readonly files: readonly ManifestFile[];
  readonly rewrites: { readonly css: number; readonly html: number };
  readonly skipped: readonly ManifestSkipped[];
  readonly totalBytes: number;
  readonly warnings: readonly UploadTaskWarning[];
}

export interface PostprocessInput {
  /** 解压清单（extract 的返回值）；脱壳会在此基础上改名 */
  readonly files: readonly ExtractedFile[];
  readonly limits: UploadLimits;
  /** §2.1：`postprocess` 段占 60-90，比例由这里算，回填到哪一格由调用方决定。 */
  readonly onProgress?: (ratio: number) => void;
  /** 改写前缀：`prototypeAccessPath(项目编码, 原型编码)`，即 `/p/crm/crm-p01`。 */
  readonly prefixPath: string;
  /** §2.4 在解压阶段跳掉的垃圾项，进 `manifest.skipped`。 */
  readonly skipped: readonly string[];
  readonly workDir: string;
}

export interface PostprocessResult {
  readonly contentHash: string;
  readonly entry: string;
  readonly manifest: ReleaseManifest;
}

/** 目录层级只按 `/` 数出来；`split` 后长度 1 表示就在根目录。 */
function segmentsOf(name: string): string[] {
  return name.split('/');
}

export async function postprocessWorkDir(input: PostprocessInput): Promise<PostprocessResult> {
  const layout = planLayout(input.files, input.limits);
  let files = input.files;
  const warnings: UploadTaskWarning[] = [];

  const top = layout.unwrapTop;
  if (top !== null) {
    await unwrapTopDir(input.workDir, top);
    files = files.map((file) => ({ ...file, name: file.name.slice(top.length + 1) }));
    warnings.push({
      code: UPLOAD_WARNING_CODES.UNWRAP_SINGLE_TOP_DIR,
      message: `已自动上提目录「${top}」，入口为 ${layout.entry}`,
    });
  }
  if (layout.multiEntryWarning !== null) {
    warnings.push(layout.multiEntryWarning);
  }

  const rewrite = await rewriteRootAbsolutePaths(
    { files, prefixPath: input.prefixPath, workDir: input.workDir },
  );
  // §5.3 的 `warnings[]` 示例第一条就是这条（§2.6 的报告原话）：改写是"平台替你改了什么"的正面记录，
  // 与 REWRITE_SKIPPED 这类问题共用同一个数组，前端发布报告一处渲染。
  const rewrittenTotal = rewrite.html + rewrite.css;
  if (rewrittenTotal > 0) {
    warnings.push({
      code: UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH,
      count: rewrittenTotal,
      message: `已将 ${String(rewrittenTotal)} 处根绝对路径改写为 ${input.prefixPath}/ 前缀（HTML ${String(rewrite.html)} 处，CSS ${String(rewrite.css)} 处）`,
    });
  }
  warnings.push(...rewrite.warnings);
  input.onProgress?.(0.2);

  const manifestFiles = await hashFiles(input.workDir, files, (ratio) => {
    input.onProgress?.(0.2 + 0.8 * ratio);
  });
  const contentHash = contentHashOf(manifestFiles);
  const manifest: ReleaseManifest = {
    entry: layout.entry,
    fileCount: manifestFiles.length,
    files: manifestFiles,
    rewrites: { css: rewrite.css, html: rewrite.html },
    skipped: input.skipped.map((path) => ({ p: path, reason: 'junk' as const })),
    totalBytes: manifestFiles.reduce((sum, file) => sum + file.size, 0),
    warnings,
  };
  return { contentHash, entry: layout.entry, manifest };
}

interface LayoutPlan {
  /** 最终坐标下的入口路径（脱壳后相对工作目录的名字） */
  readonly entry: string;
  readonly multiEntryWarning: UploadTaskWarning | null;
  /** 需要上提的唯一顶层目录；`null` 表示不改结构（§2.5 判定收窄后的结论）。 */
  readonly unwrapTop: null | string;
}

/**
 * §2.5 的三步判定，原样照抄优先级：
 * 1. 根目录有 index.html → 就是它，结束（不再有警告）。
 * 2. 段数最少的候选**唯一**，且它就在**唯一的顶层目录**下、该目录下再无其它根级文件 → 脱壳。
 * 3. 候选散落在多个不同顶层目录 → 取段数最少的作入口，结构不动，记 `MULTI_ENTRY_CANDIDATES` 并把候选列进报告。
 * 完全没有候选 → `UPLOAD_MISSING_ENTRY`。
 */
function planLayout(files: readonly ExtractedFile[], limits: UploadLimits): LayoutPlan {
  const candidates = files
    .filter((file) => isIndexEntryName(file.name))
    .map((file) => file.name)
    .sort(compareByDepthThenName);
  const first = candidates[0];
  if (first === undefined) {
    throw uploadRejected(ERROR_CODES.UPLOAD_MISSING_ENTRY, limits);
  }
  if (segmentsOf(first).length === 1) {
    // §2.5 步骤 1："结束"——根入口优先于一切，多余的候选不再惊动人。
    return { entry: first, multiEntryWarning: null, unwrapTop: null };
  }

  const onlyTop = soleTopDir(files);
  if (candidates.length === 1 && onlyTop !== null && segmentsOf(first).length === 2) {
    return {
      // §2.5 写的是 `entry = 'index.html'`，这里取候选**自己的**尾段而不是写字面量：
      // Windows 导出的 `原型/INDEX.HTML` 上提后就是 `INDEX.HTML`，Linux 的大小写敏感文件系统上
      // 报成小写会 404（清单与指针都按这个名字发）。同一份判定在 case-sensitive 与 not 上都成立。
      entry: first.slice(onlyTop.length + 1),
      multiEntryWarning: null,
      unwrapTop: onlyTop,
    };
  }

  const tops = new Set(candidates.map((name) => topDirOf(name)));
  const warning =
    tops.size >= 2
      ? {
          code: UPLOAD_WARNING_CODES.MULTI_ENTRY_CANDIDATES,
          count: candidates.length,
          message: `发现 ${String(candidates.length)} 个入口候选，已选用 "${first}"：${candidates.join('、')}`,
        }
      : null;
  return { entry: first, multiEntryWarning: warning, unwrapTop: null };
}

function compareByDepthThenName(a: string, b: string): number {
  const depth = segmentsOf(a).length - segmentsOf(b).length;
  return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
}

function topDirOf(name: string): string {
  const parts = segmentsOf(name);
  return parts.length > 1 ? parts[0] ?? '' : '';
}

/** 整个包是否只有这一个顶层目录（且根目录上没有散落的文件）——§2.5 脱壳的第二个必要条件。 */
function soleTopDir(files: readonly ExtractedFile[]): null | string {
  const tops = new Set(files.map((file) => topDirOf(file.name)));
  if (tops.size !== 1) {
    return null;
  }
  const only = [...tops][0] ?? '';
  return only === '' ? null : only;
}

/**
 * 把唯一顶层目录的内容上提为根（§2.5 步骤 2.2）。
 *
 * 用"整个目录改名到同级暂存名，再逐个孩子改回来"而不是"直接把内层目录改名上提"：
 * 内层目录可能与孩子同名（`原型/原型/…` 是常见打包结果），直接上提会撞自己的位置。
 * 两次 rename 都在同一父目录内 ⇒ 同一分区 ⇒ 原子，不需要拷贝字节。
 */
async function unwrapTopDir(workDir: string, top: string): Promise<void> {
  const staging = `${workDir}.unwrap`;
  // 上一次崩在中间留下的暂存名：先清掉，否则 rename 会撞上非空目录。
  await rm(staging, { force: true, recursive: true });
  await rename(join(workDir, top), staging);
  for (const child of await readdir(staging)) {
    await rename(join(staging, child), join(workDir, child));
  }
  await rm(staging, { force: true, recursive: true });
}

/** 逐个文件算 sha256；大小取磁盘实际值（改写之后），不取解压清单里的旧值。 */
async function hashFiles(
  workDir: string,
  files: readonly ExtractedFile[],
  onRatio: (ratio: number) => void,
): Promise<ManifestFile[]> {
  const total = files.length;
  const hashed: ManifestFile[] = [];
  let index = 0;
  for (const file of files) {
    const abs = join(workDir, file.name);
    const [sha256, statOf] = await Promise.all([sha256OfFile(abs), stat(abs)]);
    hashed.push({ p: file.name, sha256, size: statOf.size });
    index += 1;
    onRatio(total === 0 ? 1 : index / total);
  }
  return hashed.sort(byPath);
}

/**
 * §2.7：`content_hash` = 所有 `files` 按 `p` 排序后拼成 `p|size|sha256` 行文本，再取 sha256。
 * 排序用的是清单里同一个比较器：清单顺序与指纹顺序必须是同一个口径，否则"同一内容同一指纹"
 * 要多依赖一个巧合。
 */
export function contentHashOf(files: readonly ManifestFile[]): string {
  const lines = [...files]
    .sort(byPath)
    .map((file) => `${file.p}|${String(file.size)}|${file.sha256}`)
    .join('\n');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

/** 清单与指纹的排序口径：按路径字典序（§2.7）。 */
function byPath(a: ManifestFile, b: ManifestFile): number {
  return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
}

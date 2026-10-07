import { open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import yauzl from 'yauzl';

import { ERROR_CODES } from '@protohub/shared';

import { uploadRejected, type UploadLimits } from './errors';

/**
 * zip 校验与路径安全（原型发布与访问机制 §2.2 / §2.3 / §2.4）。
 *
 * 这一层是**纯函数 + yauzl**，不碰 Nest、不碰数据库：
 * 轻校验（受理阶段）与解压阶段共用同一套判定，两遍结果不可能口径漂移（§3.7 同类一次修全）。
 */

/** zip 本地文件头 `PK\x03\x04`；空包只有中央目录，头是 `PK\x05\x06`（§2.2）。 */
const ZIP_MAGICS: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
];

const S_IFLNK = 0o120000;
const UNIX_MODE_BITS = 0o170000;
const UTF8_NAME_FLAG = 0x800;

/** §2.4 的垃圾清单：Mac/IDE 打包最常见的附带内容，解压时直接跳过并记进报告。 */
const JUNK_DIRS = [
  '__MACOSX',
  '.git',
  '.svn',
  'node_modules',
  '__pycache__',
  '.idea',
  '.vscode',
] as const;
const JUNK_FILES = ['.DS_Store', 'Thumbs.db'] as const;

/** 入口文件名（大小写不敏感：Windows 导出常见 INDEX.HTML / Index.html）。 */
export const ENTRY_FILE_NAME = 'index.html';

/**
 * 入口候选判定（§2.5 步骤 1 与 2.1）：只看归一化后的最后一段，大小写不敏感。
 * 轻校验收集候选、后处理选入口与脱壳都必须是同一个口径，所以判定只在这一处（§3.7 同类收敛一处）。
 */
export function isIndexEntryName(name: string): boolean {
  const leaf = normalizeEntryName(name).split('/').at(-1) ?? '';
  return leaf.toLowerCase() === ENTRY_FILE_NAME;
}

export interface ZipEntryInfo {
  readonly compressedSize: number;
  /** 归一化并验过安全性的相对路径 */
  readonly name: string;
  readonly uncompressedSize: number;
}

export interface ZipInspection {
  /** 去掉目录项与垃圾项之后真正会被发布的条目 */
  readonly contentEntries: ZipEntryInfo[];
  readonly entryCount: number;
  /** 候选里是否有根目录级的那一个（§2.5 步骤 1 的判定口径，大小写不敏感） */
  readonly hasRootIndex: boolean;
  readonly indexCandidates: readonly string[];
  /** 被跳过的垃圾项（写进 manifest.skipped 与 warnings） */
  readonly skipped: readonly string[];
  readonly totalUncompressed: number;
}

/** 归一化（§2.3 步骤 1、2）：反斜杠统一成 `/`，去掉前导 `./`。 */
export function normalizeEntryName(raw: string): string {
  return raw.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
}

/**
 * 路径合法性（§2.3 步骤 3）：绝对路径、`..`、NUL、Windows 盘符、超长都拒绝。
 * 返回归一化后的名字；不合法时抛 `UPLOAD_UNSAFE_PATH`。
 */
export function assertSafeEntryName(rawName: string, limits: UploadLimits): string {
  const name = normalizeEntryName(rawName);
  const segments = name.split('/');
  const unsafe =
    name === '' ||
    name.startsWith('/') ||
    name.includes('\0') ||
    /^[A-Za-z]:/.test(name) ||
    name.length > 1024 ||
    segments.some(
      (segment) => segment === '..' || segment.length > 255,
    );
  if (unsafe) {
    throw uploadRejected(
      ERROR_CODES.UPLOAD_UNSAFE_PATH,
      limits,
      `条目 "${rawName.slice(0, 120)}"`,
    );
  }
  return name;
}

/**
 * 双保险（§2.3 步骤 4）：`..` 过滤依赖字符串解析每次都判对，
 * 而 `path.resolve` + 前缀断言不依赖前面任何一步的结论，是最终兜底。
 */
export function resolveExtractTarget(extractRoot: string, name: string): string {
  const root = resolve(extractRoot);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`解压目标逃出了工作目录: "${name}"`);
  }
  return target;
}

export function isDirectoryEntry(name: string): boolean {
  return name.endsWith('/');
}

/** §2.4：整目录或单文件名命中垃圾清单即跳过（跳过是发布时行为，不改用户的源文件）。 */
export function isJunkPath(name: string): boolean {
  const segments = normalizeEntryName(name).split('/').filter((part) => part !== '');
  if (segments.length === 0) {
    return true;
  }
  if (segments.some((segment) => (JUNK_DIRS as readonly string[]).includes(segment))) {
    return true;
  }
  const last = segments.at(-1) ?? '';
  return (JUNK_FILES as readonly string[]).includes(last);
}

export function isSymbolicLink(externalFileAttributes: number): boolean {
  return ((externalFileAttributes >>> 16) & UNIX_MODE_BITS) === S_IFLNK;
}

/**
 * yauzl 的 `decodeStrings: false` 分支把条目名留成 Buffer（源码里 `entry.fileName = entry.fileNameRaw`），
 * 而 @types/yauzl 只声明了 `decodeStrings: true` 那条分支的 `string`。这里唯一的转换就落在这一个函数里。
 */
interface RawNamedEntry {
  readonly fileName: Buffer;
}

/**
 * 条目名解码：UTF-8 标志位（general purpose bit 11）为 1 按 UTF-8，否则按 latin1（zip 规范里的 cp437 近亲）。
 *
 * 之所以不让 yauzl 自己解码：它自带的 `validateFileName` 会在我们看到名字之前就把 `..` / 绝对路径
 * 变成一句它自己的 fatal error，那样 §2.2 要求的 `UPLOAD_UNSAFE_PATH`（路径不合法）就只能被报成
 * `UPLOAD_NOT_ZIP`（不是 zip），用户会照着错误的建议去重新打包。名字交给我们，判定权也就交给我们。
 *
 * 轻校验与解压两趟必须用同一个解码口径，否则同一份包在两趟里看到的是两个名字（§3.7 同类一次修全）。
 */
export function decodeEntryName(entry: yauzl.Entry): string {
  const raw = (entry as unknown as RawNamedEntry).fileName;
  const isUtf8 = (entry.generalPurposeBitFlag & UTF8_NAME_FLAG) !== 0;
  return raw.toString(isUtf8 ? 'utf8' : 'latin1');
}

/** zip 魔数初查（§2.2）：改后缀的 txt 在这里就被拒，不必等到 yauzl 报中央目录读失败。 */
export async function assertZipMagic(absPath: string, limits: UploadLimits): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absPath, 'r');
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    const ok =
      bytesRead === 4 &&
      ZIP_MAGICS.some((magic) => magic.every((byte, index) => buffer[index] === byte));
    if (!ok) {
      throw uploadRejected(ERROR_CODES.UPLOAD_NOT_ZIP, limits);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'BusinessException') {
      throw error;
    }
    // 打不开文件同样按"不是有效 zip"处理：对使用者来说结论一样（§8 的文案）。
    throw uploadRejected(ERROR_CODES.UPLOAD_NOT_ZIP, limits);
  } finally {
    await handle?.close();
  }
}

/**
 * 读中央目录做全量初查（§2.1 的 validating 阶段）：条目数、单文件上限、解压总量、
 * 压缩比、符号链接、路径合法性、入口是否存在。**不解压任何字节**，所以百 MB 包也在秒级。
 *
 * 压缩比只是"提前拒绝省 IO"的辅助手段，绝对体量上限 `maxTotalBytes` 才是真防线（§2.2 注）。
 */
export function inspectZip(absPath: string, limits: UploadLimits): Promise<ZipInspection> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      absPath,
      { decodeStrings: false, lazyEntries: true, validateEntrySizes: true, autoClose: false },
      (openError, zipfile) => {
        if (openError || !zipfile) {
          rejectPromise(
            uploadRejected(
              ERROR_CODES.UPLOAD_NOT_ZIP,
              limits,
              openError instanceof Error ? openError.message : undefined,
            ),
          );
          return;
        }
        const contentEntries: ZipEntryInfo[] = [];
        const indexCandidates: string[] = [];
        const skipped: string[] = [];
        let entryCount = 0;
        let totalUncompressed = 0;
        let rejected: unknown = null;

        const failWith = (error: unknown): void => {
          if (rejected === null) {
            rejected = error;
            zipfile.close();
            rejectPromise(error);
          }
        };

        zipfile.on('error', (error: Error) => {
          // yauzl 的中央目录损坏 / 声明尺寸不符（validateEntrySizes）都归为"不是有效 zip"。
          failWith(
            uploadRejected(ERROR_CODES.UPLOAD_NOT_ZIP, limits, error.message),
          );
        });
        zipfile.on('end', () => {
          if (rejected !== null) {
            return;
          }
          zipfile.close();
          resolvePromise({
            contentEntries,
            entryCount,
            hasRootIndex: indexCandidates.some((name) => !name.includes('/')),
            indexCandidates,
            skipped,
            totalUncompressed,
          });
        });
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (rejected !== null) {
            return;
          }
          try {
            entryCount += 1;
            if (entryCount > limits.maxEntries) {
              throw uploadRejected(ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES, limits);
            }
            const rawName = decodeEntryName(entry);
            if (isSymbolicLink(entry.externalFileAttributes)) {
              throw uploadRejected(
                ERROR_CODES.UPLOAD_SYMLINK_NOT_ALLOWED,
                limits,
                rawName.slice(0, 120),
              );
            }
            const name = assertSafeEntryName(rawName, limits);
            if (entry.uncompressedSize > limits.maxFileBytes) {
              throw uploadRejected(ERROR_CODES.UPLOAD_ENTRY_TOO_LARGE, limits, name);
            }
            totalUncompressed += entry.uncompressedSize;
            if (totalUncompressed > limits.maxTotalBytes) {
              throw uploadRejected(ERROR_CODES.UPLOAD_UNCOMPRESSED_TOO_LARGE, limits);
            }
            if (isJunkPath(name)) {
              skipped.push(name);
            } else if (!isDirectoryEntry(name)) {
              contentEntries.push({
                compressedSize: entry.compressedSize,
                name,
                uncompressedSize: entry.uncompressedSize,
              });
              if (isIndexEntryName(name)) {
                indexCandidates.push(name);
              }
            }
            zipfile.readEntry();
          } catch (error: unknown) {
            failWith(error);
          }
        });
        zipfile.readEntry();
      },
    );
  });
}

/** 由中央目录结果判定"能不能受理"（§2.1：不合格立即返回 4xx，且不落任何库记录）。 */
export function assertInspectable(
  inspection: ZipInspection,
  sourceSize: number,
  limits: UploadLimits,
): void {
  if (inspection.contentEntries.length === 0) {
    throw uploadRejected(ERROR_CODES.UPLOAD_EMPTY, limits);
  }
  if (
    sourceSize > 0 &&
    inspection.totalUncompressed / sourceSize > limits.maxRatio
  ) {
    throw uploadRejected(ERROR_CODES.UPLOAD_SUSPICIOUS_RATIO, limits);
  }
  if (inspection.indexCandidates.length === 0) {
    throw uploadRejected(ERROR_CODES.UPLOAD_MISSING_ENTRY, limits);
  }
}

import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { isDiskFullError, uploadRejected, type UploadLimits } from './errors';
import {
  assertSafeEntryName,
  decodeEntryName,
  isDirectoryEntry,
  isJunkPath,
  isSymbolicLink,
  resolveExtractTarget,
} from './validate';

/**
 * 解压（机制 §2.1② / §2.3 / §2.4）：zip → `tmp/work-{taskId}/`。
 *
 * 三个"不信任"决定了这一层的形状：
 * 1. **不信任轻校验趟的结论**（§2.1 原文"逐条再做一次路径校验（不信任第一次检查）"）：每条 entry
 *    落盘前再查一次符号链接、路径合法性、`path.resolve` 前缀断言，用的是 validate.ts 里同一批函数
 *    （§3.7 同类收敛一处，两趟不可能口径漂移）。
 * 2. **不信任声明的字节数**：`MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` 在**流式写入过程中逐块累加**判定，
 *    而不是开包时按声明值算一遍（§2.2 注：绝对体量上限才是真防线，压缩比只是提前拒绝省 IO 的辅助手段）。
 *    实测分工（见 extract.spec.ts 最后一个用例）：中央目录**谎报**尺寸的条目由 yauzl 的
 *    `AssertByteCountStream` 挡在 inflate 出口（错误码 `UPLOAD_NOT_ZIP`），
 *    而"声明诚实、但确实超上限"（受理与处理之间调小阈值、跨实例阈值不一致）由这里挡。两道各管一半。
 * 3. **不信任上一次运行留下的目录**：开工先清空工作目录。任务会被重投（§3.2），而 §3.1 第 2 步是
 *    整个目录 rename 进 `releases/`，残留文件会跟着上线。
 *
 * 失败时**不**在这里清理工作目录：崩溃路径本来就没有清理机会，机制 §4.3 用"超过 24 小时的 `tmp/**`
 * 一律删除"兜底；正常失败路径要连带上传临时文件一起清，那是流水线（T8）的职责。
 */

/** 解压完成后工作目录里的一个产物文件。 */
export interface ExtractedFile {
  /** 归一化后的相对路径（`/` 分隔，不含前导 `./`） */
  readonly name: string;
  /** 实际写出的字节数；不取中央目录声明值（见"不信任②"） */
  readonly sizeBytes: number;
}

export interface ExtractResult {
  readonly files: readonly ExtractedFile[];
  /** §2.4 跳过的垃圾项，由 postprocess 写进 `warnings` 与 `manifest.skipped`。 */
  readonly skipped: readonly string[];
  readonly totalBytes: number;
  readonly workDir: string;
}

export interface ExtractInput {
  readonly limits: UploadLimits;
  /**
   * 已写出字节数的回调（§2.1：`extracting` 段按已处理字节比例回填进度）。
   *
   * 每个数据块回调一次，节流由回调方决定：这里只知道字节数，调用方才知道"多久写一次库"。
   */
  readonly onBytes?: (doneBytes: number, totalBytesHint: number) => void;
  /** 上传原始包的绝对路径（`requireLocalPath(adapter, task.tempKey)` 的返回值）。 */
  readonly sourceZip: string;
  /**
   * 进度分母，取轻校验趟从中央目录读到的解压总量声明。
   * 只用来画比例、不参与判定，所以包谎报最多让进度条难看，不会放宽任何上限。
   */
  readonly totalBytesHint: number;
  /** `tmp/work-{taskId}` 的绝对路径。 */
  readonly workDir: string;
}

/** 跨 entry 累加的已写出字节数：既是进度分子，也是总量上限的判定值。 */
interface Written {
  bytes: number;
}

export async function extractZipToWorkDir(input: ExtractInput): Promise<ExtractResult> {
  const files: ExtractedFile[] = [];
  const skipped: string[] = [];
  const written: Written = { bytes: 0 };

  await prepareWorkDir(input.workDir);
  const zipfile = await openZip(input.sourceZip, input.limits);
  const cursor = new EntryCursor(zipfile);
  try {
    let entryCount = 0;
    for (;;) {
      let entry: yauzl.Entry | null;
      try {
        entry = await cursor.next();
      } catch (error: unknown) {
        // 中央目录读到一半坏掉、`validateEntrySizes` 不符，都出在这一层（§2.2 归"不是有效 zip"）。
        throw toExtractFailure(error, input.limits);
      }
      if (entry === null) {
        break;
      }
      entryCount += 1;
      if (entryCount > input.limits.maxEntries) {
        throw uploadRejected(ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES, input.limits);
      }
      const name = inspectEntry(entry, input.limits);
      if (isDirectoryEntry(name)) {
        await mkdir(resolveExtractTarget(input.workDir, name), { recursive: true });
        continue;
      }
      if (isJunkPath(name)) {
        skipped.push(name);
        continue;
      }
      files.push({ name, sizeBytes: await writeEntry(zipfile, entry, input, written, name) });
    }
  } finally {
    zipfile.close();
  }

  return { files, skipped, totalBytes: written.bytes, workDir: input.workDir };
}

/** 开工前把工作目录复位为空目录（仍在同一分区内，所以 §3.1 的 rename 依旧是原子操作）。 */
async function prepareWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { force: true, recursive: true });
  await mkdir(workDir, { recursive: true });
}

/**
 * 单条 entry 的二次复查（§2.3 六步里跟名字与类型有关的部分）。
 * 目录项与垃圾项不需要落文件，但它们的归一化名字仍要过安全断言——判定顺序和轻校验趟保持一致。
 */
function inspectEntry(entry: yauzl.Entry, limits: UploadLimits): string {
  const rawName = decodeEntryName(entry);
  if (isSymbolicLink(entry.externalFileAttributes)) {
    throw uploadRejected(
      ERROR_CODES.UPLOAD_SYMLINK_NOT_ALLOWED,
      limits,
      rawName.slice(0, 120),
    );
  }
  return assertSafeEntryName(rawName, limits);
}

/** 把一条 entry 流式写到工作目录里的位置，返回实际写出的字节数。 */
async function writeEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  input: ExtractInput,
  written: Written,
  name: string,
): Promise<number> {
  const target = resolveExtractTarget(input.workDir, name);
  await mkdir(dirname(target), { recursive: true });
  const readStream = await openEntryStream(zipfile, entry, input.limits);
  let entryBytes = 0;

  // 上限判定放在 transform 里：块一旦越线就立刻中断这一条的流，而不是等整包写完再回头看。
  const guard = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      entryBytes += chunk.length;
      written.bytes += chunk.length;
      try {
        assertStreamingWithinLimits(input.limits, name, entryBytes, written.bytes);
      } catch (error: unknown) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      input.onBytes?.(written.bytes, input.totalBytesHint);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(readStream, guard, createWriteStream(target));
  } catch (error: unknown) {
    throw toExtractFailure(error, input.limits, name);
  }
  return entryBytes;
}

/** §2.2 的两条体量上限：单文件与总量，都按**实际流出的字节**算。 */
function assertStreamingWithinLimits(
  limits: UploadLimits,
  name: string,
  entryBytes: number,
  totalBytes: number,
): void {
  if (entryBytes > limits.maxFileBytes) {
    throw uploadRejected(ERROR_CODES.UPLOAD_ENTRY_TOO_LARGE, limits, name);
  }
  if (totalBytes > limits.maxTotalBytes) {
    throw uploadRejected(ERROR_CODES.UPLOAD_UNCOMPRESSED_TOO_LARGE, limits);
  }
}

function openZip(sourceZip: string, limits: UploadLimits): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      sourceZip,
      // validateEntrySizes：声明的解压大小与流里实际吐出的不符即报错（§2.3 步骤 5，也是一种 bomb 防护）。
      // decodeStrings:false：条目名留成 Buffer，解码与判定都由 validate.ts 负责（理由见那里的注释）。
      // autoClose:false：错误路径上由本函数显式 close，不留悬空 fd。
      { autoClose: false, decodeStrings: false, lazyEntries: true, validateEntrySizes: true },
      (error: Error | null, zipfile?: yauzl.ZipFile) => {
        if (error || !zipfile) {
          rejectPromise(
            uploadRejected(
              ERROR_CODES.UPLOAD_NOT_ZIP,
              limits,
              error instanceof Error ? error.message : undefined,
            ),
          );
          return;
        }
        resolvePromise(zipfile);
      },
    );
  });
}

function openEntryStream(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  limits: UploadLimits,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipfile.openReadStream(entry, (error: Error | null, readStream?: NodeJS.ReadableStream) => {
      if (error || !readStream) {
        // 走到这里只可能是这条 entry 自身读不出来：加密条目、不支持的压缩方式、CRC 不符。
        rejectPromise(
          uploadRejected(
            ERROR_CODES.UPLOAD_NOT_ZIP,
            limits,
            error instanceof Error ? error.message : undefined,
          ),
        );
        return;
      }
      resolvePromise(readStream);
    });
  });
}

/**
 * 解压阶段的分诊（一处收敛，两个调用点：逐条写入与逐条读取）：
 * - 自己抛的拒绝码原样上抛（`UPLOAD_ENTRY_TOO_LARGE` 等），不会被换个说法掩盖；
 * - 磁盘写满保持原异常，让 Worker 的 `uploadErrorCodeOf()` 收敛成 `UPLOAD_DISK_FULL`（§8 把它单列成一码）；
 * - 带 `E*` 的 `code` 是文件系统错误（权限 / IO / ENOSPC 之外的），不谎报成"不是有效 zip"；
 * - 其余（yauzl 的解析与校验错误）归 `UPLOAD_NOT_ZIP`，并把原始 message 作为 `detail` 附在人话后面。
 */
function toExtractFailure(error: unknown, limits: UploadLimits, detail?: string): unknown {
  if (error instanceof BusinessException || isDiskFullError(error)) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^E[A-Z]{2,4}$/.test(code)) {
    return error;
  }
  const fallback = error instanceof Error ? error.message : undefined;
  // 条目名与原始原因一起带上：只报名字的话，§8.2 要求的"指向具体原因"就缺了半句。
  const composed = detail !== undefined && fallback !== undefined
    ? `${detail}（${fallback}）`
    : detail ?? fallback;
  return uploadRejected(ERROR_CODES.UPLOAD_NOT_ZIP, limits, composed);
}

/**
 * `lazyEntries` 的回调事件流包成 await 迭代：一次只在手上留一条 entry，
 * 既不预取（内存与 fd 都不涨），也不会因为常驻监听器而泄漏。
 */
class EntryCursor {
  constructor(private readonly zipfile: yauzl.ZipFile) {}

  next(): Promise<yauzl.Entry | null> {
    return new Promise((resolvePromise, rejectPromise) => {
      const onEntry = (entry: yauzl.Entry): void => {
        cleanup();
        resolvePromise(entry);
      };
      const onEnd = (): void => {
        cleanup();
        resolvePromise(null);
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectPromise(error);
      };
      const cleanup = (): void => {
        this.zipfile.off('entry', onEntry);
        this.zipfile.off('end', onEnd);
        this.zipfile.off('error', onError);
      };
      this.zipfile.on('entry', onEntry);
      this.zipfile.on('end', onEnd);
      this.zipfile.on('error', onError);
      this.zipfile.readEntry();
    });
  }
}

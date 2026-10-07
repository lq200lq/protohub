import { deflateRawSync } from 'node:zlib';

/**
 * 手写最小 zip（STORE / DEFLATE）供发布链路的反例测试使用。
 *
 * 不用 `zip` 命令行也不引第三方打包库：反例集要构造的是**中央目录里的声明值**
 * （符号链接属性、超过 200MB 的单文件、5000+ 条目、压缩比异常），这些用真实打包工具
 * 反而做不出来，或者要真写几百 MB 数据。声明尺寸与真实数据可以不一致，但要挑对压缩方法：
 * yauzl 的 `validateEntrySizes` 对 STORE 条目要求压缩尺寸==解压尺寸，所以伪造大尺寸的条目一律走
 * DEFLATE（轻校验阶段不读数据字节，真实解压尺寸的校验发生在 M3-T5 解压时）。
 */

const CRC_POLYNOMIAL = 0xedb88320;
const CRC_BITS = 8;
const UINT32_MAX = 0xffffffff;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const DOS_TIME = 0;
const DOS_DATE = 0;
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < CRC_BITS; bit += 1) {
      value = (value & 1) === 1 ? CRC_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableValue = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (crc >>> 8) ^ tableValue;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

/** 符号链接：unix mode 高位是 `S_IFLNK`，存在 externalFileAttributes 的高 16 位。 */
export const SYMLINK_EXTERNAL_ATTRS = (0o120755 << 16) >>> 0;
const REGULAR_FILE_EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
const DIRECTORY_EXTERNAL_ATTRS = ((0o040755 << 16) >>> 0) | 0x10;

export interface ZipEntryFixture {
  /** 条目名：这里可以放 `../`、绝对路径、盘符、NUL 等真实打包工具写不出的名字 */
  readonly name: string;
  readonly data?: Buffer | string;
  readonly directory?: boolean;
  readonly method?: number;
  /** 覆盖中央目录声明的解压后体积（构造单文件超限 / 压缩比异常，不必真写那么多字节） */
  readonly uncompressedSize?: number;
  readonly externalFileAttributes?: number;
  /**
   * 条目名按 UTF-8 写并把 general purpose bit 11 置起来。
   *
   * 默认走 latin1 字节（老打包工具的 cp437 近亲），因为反例集要往名字里塞 NUL 与控制字符；
   * 但真实中文原型包（macOS Finder 压缩）用的是 UTF-8 标志位，`decodeEntryName` 的那条分支
   * 只有在这里才测得到，所以做成显式选项而不是全局改掉。
   */
  readonly utf8Name?: boolean;
}

/** general purpose bit 11：文件名与注释是 UTF-8。 */
const UTF8_NAME_FLAG = 0x800;

function entryBytes(entry: ZipEntryFixture): {
  readonly compressed: Buffer;
  readonly crc: number;
  readonly flags: number;
  readonly method: number;
  readonly nameBytes: Buffer;
  readonly uncompressedSize: number;
} {
  const raw = entry.data ?? '';
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const uncompressedSize = entry.uncompressedSize ?? data.length;
  if (uncompressedSize > UINT32_MAX) {
    throw new RangeError(
      '中央目录声明的解压尺寸不能超过 uint32（更大需要 zip64，测试里不必）',
    );
  }
  // STORE 时 yauzl 的 validateEntrySizes 要求压缩尺寸==解压尺寸，所以伪造声明尺寸的条目走 DEFLATE。
  const method =
    entry.method ?? (uncompressedSize === data.length ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE);
  const compressed = method === ZIP_METHOD_DEFLATE ? deflateRawSync(data) : data;
  return {
    compressed,
    crc: crc32(data),
    flags: entry.utf8Name === true ? UTF8_NAME_FLAG : 0,
    method,
    // 非 UTF-8 标志时用 latin1：条目名按字节写入，这样 NUL 与控制字符能原样进入中央目录。
    nameBytes: Buffer.from(entry.name, entry.utf8Name === true ? 'utf8' : 'latin1'),
    uncompressedSize,
  };
}

function localHeader(entry: ReturnType<typeof entryBytes>): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_SIZE);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(entry.nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, entry.nameBytes, entry.compressed]);
}

function centralRecord(
  entry: ReturnType<typeof entryBytes>,
  externalAttrs: number,
  localOffset: number,
): Buffer {
  const record = Buffer.alloc(CENTRAL_HEADER_SIZE);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(entry.flags, 8);
  record.writeUInt16LE(entry.method, 10);
  record.writeUInt16LE(DOS_TIME, 12);
  record.writeUInt16LE(DOS_DATE, 14);
  record.writeUInt32LE(entry.crc, 16);
  record.writeUInt32LE(entry.compressed.length, 20);
  record.writeUInt32LE(entry.uncompressedSize, 24);
  record.writeUInt16LE(entry.nameBytes.length, 28);
  record.writeUInt16LE(0, 30);
  record.writeUInt16LE(0, 32);
  record.writeUInt16LE(0, 34);
  record.writeUInt16LE(0, 36);
  record.writeUInt32LE(externalAttrs >>> 0, 38);
  record.writeUInt32LE(localOffset, 42);
  return Buffer.concat([record, entry.nameBytes]);
}

export function externalAttrsFor(entry: ZipEntryFixture): number {
  if (entry.externalFileAttributes !== undefined) {
    return entry.externalFileAttributes;
  }
  return entry.directory === true ? DIRECTORY_EXTERNAL_ATTRS : REGULAR_FILE_EXTERNAL_ATTRS;
}

export function buildZip(entries: readonly ZipEntryFixture[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const prepared = entryBytes(entry);
    const local = localHeader(prepared);
    locals.push(local);
    centrals.push(centralRecord(prepared, externalAttrsFor(entry), offset));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/** 只有中央目录、没有任何条目的 zip（§2.2 认它是合法魔数，条目为空由 UPLOAD_EMPTY 判）。 */
export function emptyZip(): Buffer {
  return buildZip([]);
}

/** zip 魔数之外的字节：改后缀的 txt / 截断的包。 */
export function notAZip(content = 'just a text file, not a zip at all'): Buffer {
  return Buffer.from(content, 'utf8');
}

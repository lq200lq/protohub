import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { UPLOAD_ERROR_HTTP_STATUS, type UploadErrorCode } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import {
  buildZip,
  emptyZip,
  notAZip,
  SYMLINK_EXTERNAL_ATTRS,
  type ZipEntryFixture,
} from '../../../testing/zip.fixture';
import { uploadLimitsOf, type UploadLimits } from './errors';
import {
  assertInspectable,
  assertSafeEntryName,
  assertZipMagic,
  inspectZip,
  isDirectoryEntry,
  isJunkPath,
  normalizeEntryName,
  resolveExtractTarget,
  type ZipInspection,
} from './validate';

/**
 * 轻校验反例集（迭代实施计划 M3-T3 + Gate G2 的"每种错误码都有单测覆盖"）。
 * 阈值默认取 env 真值（100MB/5000/200MB/500MB/1000），需要越界时用同一份阈值的小值覆盖，
 * 这样用例既验真实默认，又不必为测试写几百 MB 数据。
 */

const limits: UploadLimits = uploadLimitsOf(fakeAppEnv().env.upload);

function limitsWith(overrides: Partial<UploadLimits>): UploadLimits {
  return { ...limits, ...overrides };
}

const tempDirs: string[] = [];

async function zipFile(entries: readonly ZipEntryFixture[]): Promise<string> {
  return writeBytes(buildZip(entries));
}

async function writeBytes(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'protohub-zip-'));
  tempDirs.push(dir);
  const path = join(dir, 'upload.zip');
  await writeFile(path, bytes);
  return path;
}

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

/** 断言"以某个稳定上传错误码被拒"，并顺带验 §8 的 HTTP 语义没写反。 */
function expectBusinessCode(failure: unknown, code: UploadErrorCode): BusinessException {
  expect(failure, `期望以 ${code} 被拒，实际通过了`).toBeInstanceOf(BusinessException);
  const business = failure as BusinessException;
  expect(business.errorCode).toBe(code);
  expect(business.httpStatus).toBe(UPLOAD_ERROR_HTTP_STATUS[code]);
  return business;
}

function capture(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

function expectSyncRejectedCode(action: () => void, code: UploadErrorCode): BusinessException {
  return expectBusinessCode(capture(action), code);
}

async function expectRejectedCode(
  action: Promise<unknown>,
  code: UploadErrorCode,
): Promise<BusinessException> {
  return expectBusinessCode(
    await action.then(
      () => null,
      (error: unknown) => error,
    ),
    code,
  );
}

function inspect(entries: readonly ZipEntryFixture[], asLimits = limits): Promise<ZipInspection> {
  return zipFile(entries).then((path) => inspectZip(path, asLimits));
}

describe('条目名归一化与合法性（机制 §2.3 步骤 1~3）', () => {
  it('反斜杠统一成 /，前导 ./ 去掉', () => {
    expect(normalizeEntryName('.\\assets\\app.css')).toBe('assets/app.css');
    expect(normalizeEntryName('././index.html')).toBe('index.html');
  });

  it('合法名字返回归一化结果', () => {
    expect(assertSafeEntryName('assets/app.css', limits)).toBe('assets/app.css');
  });

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['上级逃逸', '../evil.html'],
    ['深层逃逸', 'assets/../../evil.html'],
    ['Windows 盘符', 'C:\\Windows\\win.ini'],
    ['NUL 字节', 'evil\0.html'],
    ['空名字', ''],
    ['整名超长', `${'a'.repeat(1025)}.html`],
    ['单段超长', `${'b'.repeat(256)}.html`],
  ])('拒绝非法路径：%s', (_label, name) => {
    expectSyncRejectedCode(() => assertSafeEntryName(name, limits), 'UPLOAD_UNSAFE_PATH');
  });

  it('目录项与文件项判定只看尾部斜杠', () => {
    expect(isDirectoryEntry('assets/')).toBe(true);
    expect(isDirectoryEntry('assets/app.css')).toBe(false);
  });
});

describe('解压目标双保险（机制 §2.3 步骤 4）', () => {
  it('工作目录内的目标正常返回', () => {
    expect(resolveExtractTarget('/tmp/work-1', 'assets/app.css')).toBe(
      '/tmp/work-1/assets/app.css',
    );
  });

  it('字符串过滤漏掉的逃逸由 path.resolve 前缀断言兜住', () => {
    expect(() => resolveExtractTarget('/tmp/work-1', '../escape')).toThrowError(
      /逃出了工作目录/,
    );
  });
});

describe('垃圾项清单（机制 §2.4）', () => {
  it.each([
    '__MACOSX/._index.html',
    '.DS_Store',
    'proto/.git/config',
    'node_modules/vue/dist/vue.js',
    'assets/Thumbs.db',
  ])('跳过：%s', (name) => {
    expect(isJunkPath(name)).toBe(true);
  });

  it.each(['index.html', 'assets/.hidden/app.css', 'src/index.html'])(
    '不跳过正常内容：%s',
    (name) => {
      expect(isJunkPath(name)).toBe(false);
    },
  );
});

describe('zip 魔数初查（机制 §2.2）', () => {
  it('有效 zip 通过', async () => {
    await expect(assertZipMagic(await zipFile(indexEntries()), limits)).resolves.toBeUndefined();
  });

  it('空包（只有中央目录）的魔数也算有效 zip，交给条目检查处理', async () => {
    await expect(assertZipMagic(await writeBytes(emptyZip()), limits)).resolves.toBeUndefined();
  });

  it('改后缀的 txt 以 UPLOAD_NOT_ZIP 拒绝', async () => {
    await expectRejectedCode(
      assertZipMagic(await writeBytes(notAZip()), limits),
      'UPLOAD_NOT_ZIP',
    );
  });

  it('文件读不到时同样按"不是有效 zip"给结论', async () => {
    await expectRejectedCode(
      assertZipMagic(join(tmpdir(), 'protohub-missing-file.zip'), limits),
      'UPLOAD_NOT_ZIP',
    );
  });
});

function indexEntries(): ZipEntryFixture[] {
  return [{ data: '<!doctype html>', name: 'index.html' }];
}

describe('中央目录初查 inspectZip', () => {
  it('合格包：目录项与垃圾项不进内容清单，入口被认出', async () => {
    const inspection = await inspect([
      ...indexEntries(),
      { directory: true, name: 'assets/' },
      { data: 'body{}', name: 'assets/app.css' },
      { data: '', name: '.DS_Store' },
      { data: '', name: '__MACOSX/._index.html' },
    ]);
    expect(inspection.contentEntries.map((entry) => entry.name)).toEqual([
      'index.html',
      'assets/app.css',
    ]);
    expect(inspection.indexCandidates).toEqual(['index.html']);
    expect(inspection.hasRootIndex).toBe(true);
    expect(inspection.skipped).toEqual(['.DS_Store', '__MACOSX/._index.html']);
    expect(inspection.entryCount).toBe(5);
  });

  it('入口只在子目录时 hasRootIndex 为假但候选非空（脱壳后仍可发布）', async () => {
    const inspection = await inspect([
      { directory: true, name: 'proto/' },
      { data: '<!doctype html>', name: 'proto/index.html' },
    ]);
    expect(inspection.hasRootIndex).toBe(false);
    expect(inspection.indexCandidates).toEqual(['proto/index.html']);
  });

  it('Windows 导出的 INDEX.HTML 也算入口', async () => {
    const inspection = await inspect([{ data: '<!doctype html>', name: 'INDEX.HTML' }]);
    expect(inspection.indexCandidates).toEqual(['INDEX.HTML']);
  });

  it('条目数超上限以 UPLOAD_TOO_MANY_ENTRIES 拒绝', async () => {
    const entries = [
      ...indexEntries(),
      { data: 'a', name: 'a.html' },
      { data: 'b', name: 'b.html' },
      { data: 'c', name: 'c.html' },
    ];
    await expectRejectedCode(
      inspect(entries, limitsWith({ maxEntries: 3 })),
      'UPLOAD_TOO_MANY_ENTRIES',
    );
  });

  it('符号链接条目以 UPLOAD_SYMLINK_NOT_ALLOWED 拒绝', async () => {
    await expectRejectedCode(
      inspect([
        ...indexEntries(),
        {
          data: '/etc/passwd',
          externalFileAttributes: SYMLINK_EXTERNAL_ATTRS,
          name: 'link-to-etc',
        },
      ]),
      'UPLOAD_SYMLINK_NOT_ALLOWED',
    );
  });

  it('中央目录里的 ../ 条目以 UPLOAD_UNSAFE_PATH 拒绝', async () => {
    const rejection = await expectRejectedCode(
      inspect([...indexEntries(), { data: 'x', name: '../escape.html' }]),
      'UPLOAD_UNSAFE_PATH',
    );
    // 断言文案是我们自己的那句（带条目名），而不是 yauzl 内部的名字校验——
    // 否则 §2.2 的"路径不合法"会被报成"不是 zip"，用户会照着错误的建议重新打包。
    expect(rejection.message).toBe('压缩包内含非法路径（绝对路径或 ..）：条目 "../escape.html"');
  });

  it('单文件声明体积超上限以 UPLOAD_ENTRY_TOO_LARGE 拒绝', async () => {
    await expectRejectedCode(
      inspect([
        ...indexEntries(),
        { data: 'x', name: 'big.js', uncompressedSize: limits.maxFileBytes + 1 },
      ]),
      'UPLOAD_ENTRY_TOO_LARGE',
    );
  });

  it('解压总量超上限以 UPLOAD_UNCOMPRESSED_TOO_LARGE 拒绝', async () => {
    await expectRejectedCode(
      inspect(
        [
          ...indexEntries(),
          { data: 'x', name: 'a.bin', uncompressedSize: 700 },
          { data: 'y', name: 'b.bin', uncompressedSize: 700 },
        ],
        limitsWith({ maxFileBytes: 1000, maxTotalBytes: 1000 }),
      ),
      'UPLOAD_UNCOMPRESSED_TOO_LARGE',
    );
  });

  it('DEFLATE 条目也走同一套检查', async () => {
    const inspection = await inspect([
      { data: '<!doctype html><h1>hi</h1>'.repeat(32), method: 8, name: 'index.html' },
    ]);
    expect(inspection.contentEntries).toHaveLength(1);
    expect(inspection.totalUncompressed).toBeGreaterThan(0);
  });

  it('中央目录被截断时以 UPLOAD_NOT_ZIP 拒绝', async () => {
    const bytes = buildZip(indexEntries());
    await expectRejectedCode(
      writeBytes(bytes.subarray(0, bytes.length - 30)).then((path) => inspectZip(path, limits)),
      'UPLOAD_NOT_ZIP',
    );
  });

  it('非 zip 字节直接读中央目录也以 UPLOAD_NOT_ZIP 拒绝', async () => {
    await expectRejectedCode(
      writeBytes(notAZip()).then((path) => inspectZip(path, limits)),
      'UPLOAD_NOT_ZIP',
    );
  });
});

describe('受理判定 assertInspectable（机制 §2.1 validating）', () => {
  it('只有垃圾项时以 UPLOAD_EMPTY 拒绝', async () => {
    const inspection = await inspect([
      { data: '', name: '.DS_Store' },
      { data: '', name: '__MACOSX/foo' },
    ]);
    expectSyncRejectedCode(
      () => assertInspectable(inspection, 1024, limits),
      'UPLOAD_EMPTY',
    );
  });

  it('压缩比异常以 UPLOAD_SUSPICIOUS_RATIO 拒绝（声明解压后 4MB 而源包只有几百字节）', async () => {
    const inspection = await inspect([
      { data: 'x', name: 'index.html', uncompressedSize: 4 * 1024 * 1024 },
    ]);
    expectSyncRejectedCode(
      () => assertInspectable(inspection, 256, limits),
      'UPLOAD_SUSPICIOUS_RATIO',
    );
  });

  it('没有 index.html 时以 UPLOAD_MISSING_ENTRY 拒绝', async () => {
    const inspection = await inspect([{ data: 'x', name: 'start.html' }]);
    expectSyncRejectedCode(
      () => assertInspectable(inspection, 1024, limits),
      'UPLOAD_MISSING_ENTRY',
    );
  });

  it('合格包不抛', async () => {
    const inspection = await inspect(indexEntries());
    expect(() => assertInspectable(inspection, 512, limits)).not.toThrow();
  });
});

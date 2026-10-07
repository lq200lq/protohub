import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { UPLOAD_ERROR_HTTP_STATUS, type UploadErrorCode } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import {
  buildZip,
  notAZip,
  SYMLINK_EXTERNAL_ATTRS,
  ZIP_METHOD_DEFLATE,
  type ZipEntryFixture,
} from '../../../testing/zip.fixture';
import { uploadLimitsOf, type UploadLimits } from './errors';
import { extractZipToWorkDir, type ExtractResult } from './extract';

/**
 * 解压阶段（机制 §2.1② / §2.3 / §2.4；计划 M3-T5 与"安全反例集"的解压那一半）。
 *
 * 与轻校验趟（validate.spec.ts）的分工：那边验"照中央目录声明值读出来的结论"，这边验**真实字节流经时**
 * 的行为——§2.1 明写解压要"逐条再做一次路径校验（不信任第一次检查）"，所以下面凡是体量上限的用例喂的都是
 * 声明与真实一致的老实包 + 调小的上限，逼出"由解压自己拦下来"这条路径，而不是靠轻校验已经拦过。
 * 谎报尺寸那一类另有归属，见最后一个用例（实测：yauzl 在 inflate 与写盘之间插了计数，越界字节到不了我们手上）。
 */

const baseLimits: UploadLimits = uploadLimitsOf(fakeAppEnv().env.upload);

function limitsWith(overrides: Partial<UploadLimits>): UploadLimits {
  return { ...baseLimits, ...overrides };
}

const tempDirs: string[] = [];

interface Harness {
  readonly result: Promise<ExtractResult>;
  readonly sourceZip: string;
  readonly workDir: string;
}

async function harness(
  entries: readonly ZipEntryFixture[] | Buffer,
  options: { readonly limits?: UploadLimits; readonly onBytes?: (done: number, total: number) => void } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'protohub-extract-'));
  tempDirs.push(dir);
  const sourceZip = join(dir, 'upload.zip');
  await writeFile(sourceZip, Buffer.isBuffer(entries) ? entries : buildZip(entries));
  const workDir = join(dir, 'work');
  return {
    result: extractZipToWorkDir({
      limits: options.limits ?? baseLimits,
      onBytes: options.onBytes,
      sourceZip,
      totalBytesHint: 0,
      workDir,
    }),
    sourceZip,
    workDir,
  };
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

async function rejection(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => null,
    (error: unknown) => error,
  );
}

/** 断言以某个稳定上传错误码被拒，并顺带验 §8 的 HTTP 语义没写反。 */
async function expectRejectedCode(
  action: Promise<unknown>,
  code: UploadErrorCode,
): Promise<BusinessException> {
  const failure = await rejection(action);
  expect(failure, `期望以 ${code} 被拒，实际通过了`).toBeInstanceOf(BusinessException);
  const business = failure as BusinessException;
  expect(business.errorCode).toBe(code);
  expect(business.httpStatus).toBe(UPLOAD_ERROR_HTTP_STATUS[code]);
  return business;
}

function indexEntries(): ZipEntryFixture[] {
  return [{ data: '<!doctype html><h1>hi</h1>', name: 'index.html' }];
}

describe('合格包解压（§2.1② 的正常路径）', () => {
  it('内容落进工作目录，嵌套目录自动建出来，实际字节数入账', async () => {
    const box = await harness([
      ...indexEntries(),
      { directory: true, name: 'assets/' },
      { data: 'body{color:red}', method: ZIP_METHOD_DEFLATE, name: 'assets/app.css' },
      { data: '\u{1f600}', name: '中文/备注.txt', utf8Name: true },
    ]);
    const result = await box.result;

    expect(result.files.map((file) => file.name)).toEqual([
      'index.html',
      'assets/app.css',
      '中文/备注.txt',
    ]);
    expect(await readFile(join(box.workDir, 'index.html'), 'utf8')).toBe('<!doctype html><h1>hi</h1>');
    expect(await readFile(join(box.workDir, 'assets/app.css'), 'utf8')).toBe('body{color:red}');
    expect(await readFile(join(box.workDir, '中文/备注.txt'), 'utf8')).toBe('\u{1f600}');
    // sizeBytes 取实际写出的字节，不是中央目录声明值。
    expect(result.files[1]?.sizeBytes).toBe(Buffer.byteLength('body{color:red}'));
    expect(result.totalBytes).toBe(
      result.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    );
    expect(result.workDir).toBe(box.workDir);
  });

  it('目录项只建目录、不进产物清单', async () => {
    const box = await harness([
      ...indexEntries(),
      { directory: true, name: 'empty-dir/' },
    ]);
    const result = await box.result;
    expect(result.files.map((file) => file.name)).toEqual(['index.html']);
    expect((await stat(join(box.workDir, 'empty-dir'))).isDirectory()).toBe(true);
  });

  it('§2.4 的垃圾项不落盘，但如实记进 skipped 供发布报告使用', async () => {
    const box = await harness([
      ...indexEntries(),
      { data: '', name: '.DS_Store' },
      { data: 'x', name: '__MACOSX/._index.html' },
      { data: 'secret', name: 'proto/.git/config' },
    ]);
    const result = await box.result;
    expect(result.skipped).toEqual(['.DS_Store', '__MACOSX/._index.html', 'proto/.git/config']);
    await expect(readFile(join(box.workDir, '.DS_Store'), 'utf8')).rejects.toThrowError();
    await expect(readFile(join(box.workDir, 'proto/.git/config'), 'utf8')).rejects.toThrowError();
  });

  it('开工前清掉上一轮留下的文件（§3.2 重投后不得把残留带上线）', async () => {
    const box = await harness(indexEntries());
    await box.result;
    // 造"上一轮跑了一半被 kill"的现场：工作目录里有一个本轮清单之外的文件。
    await writeFile(join(box.workDir, 'stale-from-last-run.html'), 'old');

    const rebuilt = await extractZipToWorkDir({
      limits: baseLimits,
      sourceZip: box.sourceZip,
      totalBytesHint: 0,
      workDir: box.workDir,
    });
    expect(rebuilt.files.map((file) => file.name)).toEqual(['index.html']);
    await expect(
      readFile(join(box.workDir, 'stale-from-last-run.html'), 'utf8'),
    ).rejects.toThrowError();
  });
});

describe('进度回填（§2.1：extracting 段按已处理字节比例）', () => {
  it('回调单调递增，末次等于实际写出的总量', async () => {
    const seen: number[] = [];
    const box = await harness(
      [
        ...indexEntries(),
        { data: 'a'.repeat(5000), method: ZIP_METHOD_DEFLATE, name: 'big.js' },
      ],
      { onBytes: (done) => seen.push(done) },
    );
    const result = await box.result;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(result.totalBytes);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index] ?? 0).toBeGreaterThanOrEqual(seen[index - 1] ?? 0);
    }
  });
});

describe('体量上限在字节流经时拦住（§2.2 的"绝对值才是真防线"）', () => {
  // 轻校验趟已经按声明值拦过一次；解压这一趟必须**自己再拦一次**（§2.1"不信任第一次检查"）。
  // 下面三个用例喂的都是声明与真实一致的老实包，只把上限换成小值——
  // 等价于"受理时 200MB、处理时运维把 MAX_FILE_BYTES 调成 1KB"这类跨时间/跨实例的情形。
  it('单文件实际字节超上限以 UPLOAD_ENTRY_TOO_LARGE 拒绝', async () => {
    const box = await harness(
      [{ data: 'x'.repeat(4096), method: ZIP_METHOD_DEFLATE, name: 'big.js' }],
      { limits: limitsWith({ maxFileBytes: 1024 }) },
    );
    const business = await expectRejectedCode(box.result, 'UPLOAD_ENTRY_TOO_LARGE');
    expect(business.message).toBe('存在超过 1KB 的单个文件：big.js');
  });

  it('逐条累加超过解压总量以 UPLOAD_UNCOMPRESSED_TOO_LARGE 拒绝', async () => {
    const box = await harness(
      [
        { data: 'x'.repeat(2000), method: ZIP_METHOD_DEFLATE, name: 'index.html' },
        { data: 'y'.repeat(2000), method: ZIP_METHOD_DEFLATE, name: 'a.js' },
      ],
      { limits: limitsWith({ maxFileBytes: 5000, maxTotalBytes: 3000 }) },
    );
    await expectRejectedCode(box.result, 'UPLOAD_UNCOMPRESSED_TOO_LARGE');
  });

  it('条目数超上限以 UPLOAD_TOO_MANY_ENTRIES 拒绝', async () => {
    const box = await harness(
      [
        ...indexEntries(),
        { data: 'a', name: 'a.html' },
        { data: 'b', name: 'b.html' },
        { data: 'c', name: 'c.html' },
      ],
      { limits: limitsWith({ maxEntries: 3 }) },
    );
    await expectRejectedCode(box.result, 'UPLOAD_TOO_MANY_ENTRIES');
  });

  /**
   * "声明 10 字节、实际吐 4KB"的谎报条目：拦住它的是 yauzl 的 `AssertByteCountStream`
   * （validateEntrySizes 在 inflate 与我们的写入流之间又插了一道计数），
   * 我们的流式上限因此看不到越界字节。错误码是 `UPLOAD_NOT_ZIP` 而不是体量码——
   * 实测确认，不是推断：谎报尺寸的包本来就是坏包，§8 给它的建议（"重新导出 zip"）也对得上。
   * 两道防线各管一半：谎报由 yauzl 挡、老实但超限由我们挡，谁都没漏。
   */
  it('谎报尺寸的压缩炸弹条目被 yauzl 挡在写入之前', async () => {
    const box = await harness(
      [{ data: 'x'.repeat(4096), method: ZIP_METHOD_DEFLATE, name: 'bomb.js', uncompressedSize: 10 }],
      { limits: limitsWith({ maxFileBytes: 1024 }) },
    );
    const business = await expectRejectedCode(box.result, 'UPLOAD_NOT_ZIP');
    // 人话 + 具体原因（§8.2：条目名和越界字节数都要看得见，报障时不必登服务器）
    expect(business.message).toContain('bomb.js');
    expect(business.message).toContain('too many bytes');
  });
});

describe('逐条二次复查（§2.1"不信任第一次检查"）', () => {
  it.each([
    ['上级逃逸', '../evil.html'],
    ['绝对路径', '/etc/passwd'],
    ['Windows 盘符', 'C:\\Windows\\win.ini'],
    ['深层逃逸', 'assets/../../../evil.html'],
  ])('拒绝非法路径：%s', async (_label, name) => {
    const box = await harness([...indexEntries(), { data: 'x', name }]);
    const business = await expectRejectedCode(box.result, 'UPLOAD_UNSAFE_PATH');
    // 必须是我们自己的话术：yauzl 自己那套名字校验会把"路径不合法"报成"不是 zip"（§2.2）。
    expect(business.message).toContain('压缩包内含非法路径');
    expect(business.message).not.toContain('zip 格式');
  });

  it('符号链接条目以 UPLOAD_SYMLINK_NOT_ALLOWED 拒绝', async () => {
    const box = await harness([
      ...indexEntries(),
      { data: '/etc/passwd', externalFileAttributes: SYMLINK_EXTERNAL_ATTRS, name: 'evil-link' },
    ]);
    await expectRejectedCode(box.result, 'UPLOAD_SYMLINK_NOT_ALLOWED');
  });
});

describe('读不出来的包（§2.2 的 UPLOAD_NOT_ZIP 与 §8 的兜底分诊）', () => {
  it('非 zip 字节以 UPLOAD_NOT_ZIP 拒绝', async () => {
    const box = await harness(notAZip());
    await expectRejectedCode(box.result, 'UPLOAD_NOT_ZIP');
  });

  it('中央目录被截断时同样收敛到 UPLOAD_NOT_ZIP', async () => {
    const bytes = buildZip(indexEntries());
    const box = await harness(bytes.subarray(0, bytes.length - 30));
    await expectRejectedCode(box.result, 'UPLOAD_NOT_ZIP');
  });

  it('文件系统错误不谎报成"不是有效 zip"，原样交给 Worker 分诊（§8 的 UPLOAD_WORKER_FAILED 兜底）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'protohub-extract-fs-'));
    tempDirs.push(dir);
    const sourceZip = join(dir, 'upload.zip');
    await writeFile(sourceZip, buildZip(indexEntries()));
    // 工作目录的父级是一个普通文件：mkdir 必然失败（ENOTDIR），这不是包的问题。
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');

    const failure = await rejection(
      extractZipToWorkDir({
        limits: baseLimits,
        sourceZip,
        totalBytesHint: 0,
        workDir: join(blocker, 'work'),
      }),
    );
    expect(failure).not.toBeInstanceOf(BusinessException);
    expect((failure as { code?: string }).code).toMatch(/^EN/);
  });
});

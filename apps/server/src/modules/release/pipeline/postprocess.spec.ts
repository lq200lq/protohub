import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  UPLOAD_ERROR_HTTP_STATUS,
  UPLOAD_WARNING_CODES,
  type UploadErrorCode,
  type UploadTaskWarning,
  type UploadWarningCode,
} from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import { uploadLimitsOf, type UploadLimits } from './errors';
import type { ExtractedFile } from './extract';
import {
  contentHashOf,
  postprocessWorkDir,
  type ManifestFile,
  type PostprocessResult,
} from './postprocess';

/**
 * 后处理（机制 §2.1③ / §2.5 / §2.6 / §2.7；计划 M3-T6 的判据：
 * "常见 Mac 打包结构能正确脱壳；多候选时给出 `MULTI_ENTRY_CANDIDATES` 警告"）。
 *
 * 与 extract.spec.ts 的分工：那边验"字节怎么从 zip 落到工作目录"，这边验**目录已经就位之后**
 * 的结构判定与产物结论，所以夹具直接写文件、不再打包——脱壳、入口、清单、指纹的结论只取决于目录形状。
 * 断言一律两头都看：清单里的 `p`/`size`/`sha256` 必须对得上**磁盘上真实存在**的文件与字节，
 * 否则"清单说得漂亮、目录根本不是那样"的版本照样能过测。
 */

const limits: UploadLimits = uploadLimitsOf(fakeAppEnv().env.upload);
const PREFIX = '/p/crm/crm-p01';

interface Fixture {
  readonly content: string;
  readonly name: string;
}

const tempDirs: string[] = [];

interface Harness {
  readonly dir: string;
  readonly run: () => Promise<PostprocessResult>;
}

/** 造好工作目录，返回一个"按解压清单调用后处理"的夹具。 */
async function harness(
  files: readonly Fixture[],
  skipped: readonly string[] = [],
  onProgress?: (ratio: number) => void,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-post-'));
  tempDirs.push(root);
  const workDir = join(root, 'work');
  for (const file of files) {
    const abs = join(workDir, file.name);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
  }
  const extracted: readonly ExtractedFile[] = files.map((file) => ({
    name: file.name,
    sizeBytes: Buffer.byteLength(file.content),
  }));
  return {
    dir: workDir,
    run: () =>
      postprocessWorkDir({
        files: extracted,
        limits,
        onProgress,
        prefixPath: PREFIX,
        skipped,
        workDir,
      }),
  };
}

async function expectRejectedCode(
  action: Promise<unknown>,
  code: UploadErrorCode,
): Promise<BusinessException> {
  const failure = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure, `期望以 ${code} 结束，实际通过了`).toBeInstanceOf(BusinessException);
  const business = failure as BusinessException;
  expect(business.errorCode).toBe(code);
  expect(business.httpStatus).toBe(UPLOAD_ERROR_HTTP_STATUS[code]);
  return business;
}

/** `readdir` 不保证顺序，比较前先排序（否则同一份代码在别的文件系统上会随机红）。 */
async function ls(dir: string): Promise<string[]> {
  return [...(await readdir(dir))].sort();
}

async function diskFile(dir: string, name: string): Promise<Buffer> {
  return readFile(join(dir, name));
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pathsOf(files: readonly ManifestFile[]): string[] {
  return files.map((file) => file.p);
}

function warningOf(result: PostprocessResult, code: UploadWarningCode): UploadTaskWarning {
  const warning = result.manifest.warnings.find((item) => item.code === code);
  expect(warning, `清单里应当有 ${code} 这条`).toBeDefined();
  return warning as UploadTaskWarning;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('入口探测与脱壳（§2.5）', () => {
  it('Mac 打包结构（唯一顶层目录 + 唯一候选）：内容上提为根，entry 是上提后的真实名字', async () => {
    const fixture = await harness([
      { content: '<!doctype html><h1>登录流程</h1>', name: '登录流程/index.html' },
      { content: 'body{}', name: '登录流程/assets/app.css' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('index.html');
    expect(pathsOf(result.manifest.files)).toEqual(['assets/app.css', 'index.html']);
    // 磁盘上真的不再有那层目录：清单说上提了，目录没说谎。
    expect(await ls(fixture.dir)).toEqual(['assets', 'index.html']);
    await expect(diskFile(fixture.dir, '登录流程/index.html')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const unwrap = warningOf(result, UPLOAD_WARNING_CODES.UNWRAP_SINGLE_TOP_DIR);
    expect(unwrap.message).toContain('登录流程');
    expect(unwrap.message).toContain('入口为 index.html');
  });

  it('内层与外层同名（原型/原型/…）也能上提，孩子不被自己的名字挡住', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: '原型/index.html' },
      { content: 'detail', name: '原型/原型/detail.html' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('index.html');
    expect(pathsOf(result.manifest.files)).toEqual(['index.html', '原型/detail.html']);
    expect((await diskFile(fixture.dir, '原型/detail.html')).toString('utf8')).toBe('detail');
    expect(await ls(fixture.dir)).toEqual(['index.html', '原型']);
  });

  it('上一次崩在中间留下的暂存目录不会挡住重投', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: '包/index.html' },
      { content: 'a', name: '包/a.css' },
    ]);
    const staging = `${fixture.dir}.unwrap`;
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'leftover.txt'), 'crash leftover', 'utf8');
    const result = await fixture.run();
    expect(result.entry).toBe('index.html');
    // 用完连残留一起清掉，不在 tmp 里留到 §4.3 的 24 小时 GC。
    await expect(diskFile(staging, 'leftover.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('根目录已有 index.html 时不脱壳，也不为多余候选报警（§2.5 步骤 1 的"结束"）', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: 'index.html' },
      { content: '<!doctype html>', name: '备份/index.html' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('index.html');
    expect(result.manifest.warnings).toEqual([]);
    expect(await ls(fixture.dir)).toEqual(['index.html', '备份']);
  });

  it('候选跨多个顶层目录：取最浅的作入口、结构不动，记 MULTI_ENTRY_CANDIDATES 并列出候选', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: '登录/index.html' },
      { content: '<!doctype html>', name: '首页/index.html' },
      { content: '<!doctype html>', name: '首页/deep/nested/index.html' },
      { content: 'a', name: '登录/a.css' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('登录/index.html');
    const warning = warningOf(result, UPLOAD_WARNING_CODES.MULTI_ENTRY_CANDIDATES);
    expect(warning.count).toBe(3);
    expect(warning.message).toContain('登录/index.html');
    expect(warning.message).toContain('首页/deep/nested/index.html');
    // 结构没动（两层的目录还在），脱壳警告也不该出现。
    expect(await ls(fixture.dir)).toEqual(['登录', '首页']);
    expect(
      result.manifest.warnings.some(
        (item) => item.code === UPLOAD_WARNING_CODES.UNWRAP_SINGLE_TOP_DIR,
      ),
    ).toBe(false);
  });

  it('同一顶层目录里的多个候选：既不脱壳也不报错（§2.5 的判定刻意收窄）', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: '包/index.html' },
      { content: '<!doctype html>', name: '包/子页/index.html' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('包/index.html');
    expect(result.manifest.warnings).toEqual([]);
    expect(await ls(fixture.dir)).toEqual(['包']);
  });

  it('唯一候选深到第三层：保守起见不猜，入口就是那个深层路径', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: '包/pages/index.html' },
      { content: 'a', name: '包/assets/a.css' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('包/pages/index.html');
    expect(await ls(fixture.dir)).toEqual(['包']);
  });

  it('一个候选都没有：以 UPLOAD_MISSING_ENTRY 失败（§2.5 步骤 3）', async () => {
    const fixture = await harness([{ content: '<h1>只有开始页</h1>', name: 'start.html' }]);
    await expectRejectedCode(fixture.run(), ERROR_CODES.UPLOAD_MISSING_ENTRY);
  });

  it('Windows 导出的大写入口：脱壳后 entry 用它自己的名字，不是字面量 index.html', async () => {
    // 生产文件系统大小写敏感。报成 index.html 会让指针与清单一起指向一个不存在的文件（404）。
    const fixture = await harness([
      { content: '<!doctype html>', name: '导出/INDEX.HTML' },
      { content: 'a', name: '导出/a.css' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('INDEX.HTML');
    expect(pathsOf(result.manifest.files)).toEqual(['INDEX.HTML', 'a.css']);
  });
});

describe('改写与指纹的先后（§2.1③：清单打在最终字节上）', () => {
  it('sha256 与 size 是改写之后的产物，不是源文件', async () => {
    const source = '<!doctype html><script src="/app.js"></script>';
    const fixture = await harness([
      { content: source, name: 'index.html' },
      { content: 'const a = 1;', name: 'app.js' },
    ]);
    const result = await fixture.run();
    const index = result.manifest.files.find((file) => file.p === 'index.html');
    const served = await diskFile(fixture.dir, 'index.html');
    expect(index?.sha256).toBe(sha256(served));
    expect(index?.size).toBe(served.byteLength);
    // 也就是说：指纹与源文件不同（源里是 /app.js，发出去的是带前缀的那份）。
    expect(index?.sha256).not.toBe(sha256(source));
    expect(served.toString('utf8')).toContain(`${PREFIX}/app.js`);
  });

  it('改写条数进 manifest.rewrites，同时给发布报告一条 REWRITE_ABSOLUTE_PATH（§2.6/§5.3）', async () => {
    const fixture = await harness([
      {
        content: '<!doctype html><link href="/a.css"><img src="/b.png" srcset="/c.png 2x">',
        name: 'index.html',
      },
      { content: '.a{background:url(/d.png)}', name: 'a.css' },
    ]);
    const result = await fixture.run();
    expect(result.manifest.rewrites).toEqual({ css: 1, html: 3 });
    const summary = warningOf(result, UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH);
    expect(summary.count).toBe(4);
    expect(summary.message).toBe(
      '已将 4 处根绝对路径改写为 /p/crm/crm-p01/ 前缀（HTML 3 处，CSS 1 处）',
    );
  });

  it('一处都没改时不产生 REWRITE_ABSOLUTE_PATH 噪声', async () => {
    const fixture = await harness([
      { content: '<!doctype html><img src="assets/a.png">', name: 'index.html' },
    ]);
    const result = await fixture.run();
    expect(result.manifest.rewrites).toEqual({ css: 0, html: 0 });
    expect(result.manifest.warnings).toEqual([]);
  });

  it('脱壳之后才改写：上提改变的路径，改写要看得见', async () => {
    const fixture = await harness([
      { content: '<!doctype html><link href="/a.css">', name: '包/index.html' },
      { content: 'x', name: '包/a.css' },
    ]);
    const result = await fixture.run();
    expect(result.entry).toBe('index.html');
    expect(result.manifest.rewrites).toEqual({ css: 0, html: 1 });
    // 改写落在上提后的那份文件上（脱壳在前，路径才对得上）。
    expect((await diskFile(fixture.dir, 'index.html')).toString('utf8')).toContain(
      `href="${PREFIX}/a.css"`,
    );
  });
});

describe('清单与 content_hash（§2.7）', () => {
  it('清单按 p 排序，totalBytes 与 fileCount 对得上磁盘，每项都带 sha256', async () => {
    const fixture = await harness([
      { content: '<!doctype html>', name: 'index.html' },
      { content: 'a'.repeat(2048), name: 'assets/big.js' },
      { content: 'body{}', name: 'assets/app.css' },
    ]);
    const result = await fixture.run();
    expect(result.manifest.fileCount).toBe(3);
    expect(result.manifest.totalBytes).toBe(15 + 2048 + 6);
    expect(pathsOf(result.manifest.files)).toEqual([
      'assets/app.css',
      'assets/big.js',
      'index.html',
    ]);
    for (const file of result.manifest.files) {
      const bytes = await diskFile(fixture.dir, file.p);
      expect(file.size).toBe(bytes.byteLength);
      expect(file.sha256).toBe(sha256(bytes));
    }
  });

  it('垃圾项进 manifest.skipped（带 reason），不进 files', async () => {
    const fixture = await harness(
      [{ content: '<!doctype html>', name: 'index.html' }],
      ['.DS_Store', '__MACOSX/._index.html'],
    );
    const result = await fixture.run();
    expect(result.manifest.skipped).toEqual([
      { p: '.DS_Store', reason: 'junk' },
      { p: '__MACOSX/._index.html', reason: 'junk' },
    ]);
    expect(pathsOf(result.manifest.files)).toEqual(['index.html']);
  });

  it('同一批文件换顺序得到同一个 content_hash（指纹不依赖遍历顺序）', async () => {
    const first = await harness([
      { content: '<!doctype html>', name: 'index.html' },
      { content: 'body{}', name: 'a.css' },
    ]);
    const second = await harness([
      { content: 'body{}', name: 'a.css' },
      { content: '<!doctype html>', name: 'index.html' },
    ]);
    expect((await second.run()).contentHash).toBe((await first.run()).contentHash);
  });

  it('指纹按最终路径算：同一份内容"包一层能脱壳的目录"不算新版本，深层入口才算', async () => {
    const content = '<!doctype html>';
    const flat = await harness([{ content, name: 'index.html' }]);
    const wrapped = await harness([{ content, name: '包/index.html' }]);
    const deep = await harness([{ content, name: '包/pages/index.html' }]);
    // §2.7 的去重提示比的是发出去的产物：脱壳把 `包/index.html` 变成 `index.html`，
    // 与扁平版是同一份东西，不该让用户看到"内容相同"却被判成两版。
    expect((await wrapped.run()).contentHash).toBe((await flat.run()).contentHash);
    // 深层目录脱不了壳（§2.5 判定收窄），入口路径真的不同，就必须是另一版。
    expect((await deep.run()).contentHash).not.toBe((await flat.run()).contentHash);
  });

  it('改一个字节，content_hash 就变（去重提示才有意义）', async () => {
    const before = await harness([{ content: '<!doctype html><p>1</p>', name: 'index.html' }]);
    const after = await harness([{ content: '<!doctype html><p>2</p>', name: 'index.html' }]);
    expect((await after.run()).contentHash).not.toBe((await before.run()).contentHash);
  });

  it('content_hash 就是排序后的 p|size|sha256 行文本的 sha256', () => {
    const files: ManifestFile[] = [
      { p: 'b.html', sha256: 'BB', size: 2 },
      { p: 'a.html', sha256: 'AA', size: 1 },
    ];
    expect(contentHashOf(files)).toBe(
      createHash('sha256')
        .update('a.html|1|AA\nb.html|2|BB', 'utf8')
        .digest('hex'),
    );
  });

  it('进度覆盖改写之后的整段，单调推进到 1（§2.1：postprocess 占 60-90 由调用方换算）', async () => {
    const ratios: number[] = [];
    const fixture = await harness(
      [
        { content: '<!doctype html>', name: 'index.html' },
        { content: 'b', name: 'b.css' },
        { content: 'c', name: 'c.css' },
        { content: 'd', name: 'd.css' },
      ],
      [],
      (ratio) => {
        ratios.push(ratio);
      },
    );
    await fixture.run();
    // 0.2 是"改写完了"这一格，之后按文件数推进；0.2+0.8*ratio 有二进制浮点误差，比较到 4 位小数。
    expect(ratios.map((ratio) => Number(ratio.toFixed(4)))).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect([...ratios].sort((a, b) => a - b)).toEqual(ratios);
    expect(ratios.at(-1)).toBe(1);
  });
});

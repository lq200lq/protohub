import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { UPLOAD_WARNING_CODES, type UploadWarningCode } from '@protohub/shared';

import { REWRITE_MAX_FILE_BYTES } from '../../../config/constants';
import {
  prefixIfRootAbsolute,
  rewriteRootAbsolutePaths,
  rewriteSrcset,
  type RewriteOutcome,
} from './rewrite';

/**
 * 根绝对路径改写（机制 §2.6；计划 M3-T7 的判据："单测覆盖每条约束与 `//cdn`、`data:`、`http:` 不误改"）。
 *
 * 这一层直接对着**工作目录里的真实文件**跑（不经过解压）：要验的是"改哪些、不改哪些、改不动怎么办"，
 * 字节从哪来与它无关。断言一律落在两处——落盘的字节 + 返回的条数与警告，只看其一都放行不了缺陷：
 * 只断言条数会漏"数了却没写"，只断言内容会漏"写了却没数"（报告与 manifest.rewrites 都要对上）。
 */

const PREFIX = '/p/crm/crm-p01';

const tempDirs: string[] = [];

interface Fixture {
  readonly content: string;
  readonly name: string;
}

/** 写出一组文件，返回工作目录；名字里的子目录会自动建。 */
async function workDirWith(files: readonly Fixture[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'protohub-rewrite-'));
  tempDirs.push(dir);
  for (const file of files) {
    const abs = join(dir, file.name);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, 'utf8');
  }
  return dir;
}

async function rewrite(
  files: readonly Fixture[],
  prefix: string = PREFIX,
): Promise<{ readonly dir: string; readonly outcome: RewriteOutcome }> {
  const dir = await workDirWith(files);
  const outcome = await rewriteRootAbsolutePaths({
    files: files.map((file) => ({ name: file.name, sizeBytes: Buffer.byteLength(file.content) })),
    prefixPath: prefix,
    workDir: dir,
  });
  return { dir, outcome };
}

async function read(dir: string, name: string): Promise<string> {
  return readFile(join(dir, name), 'utf8');
}

function warningCodes(outcome: RewriteOutcome): UploadWarningCode[] {
  return outcome.warnings.map((warning) => warning.code);
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('HTML 属性改写（§2.6 表格第一行点名的五个属性 + srcset）', () => {
  it('src/href/poster/data-src 的根绝对值都加前缀，条数按处计', async () => {
    const { dir, outcome } = await rewrite([
      {
        content:
          '<!doctype html><html><head><link href="/a.css"></head><body>' +
          '<img src="/b.png" data-src="/c.png">' +
          '<video poster="/d.mp4"><source src="/e.webm"></video>' +
          '</body></html>',
        name: 'index.html',
      },
    ]);
    expect(outcome.html).toBe(5);
    expect(outcome.css).toBe(0);
    const html = await read(dir, 'index.html');
    expect(html).toContain('href="/p/crm/crm-p01/a.css"');
    expect(html).toContain('src="/p/crm/crm-p01/b.png"');
    expect(html).toContain('data-src="/p/crm/crm-p01/c.png"');
    expect(html).toContain('poster="/p/crm/crm-p01/d.mp4"');
    expect(html).toContain('src="/p/crm/crm-p01/e.webm"');
  });

  it('srcset 只改每段第一部分，描述符原样保留', async () => {
    const { dir, outcome } = await rewrite([
      {
        content:
          '<!doctype html><img srcset="/a-1x.png 1x, /b-2x.png 2x 600w" alt="">',
        name: 'index.html',
      },
    ]);
    expect(outcome.html).toBe(2);
    const html = await read(dir, 'index.html');
    expect(html).toContain(`${PREFIX}/a-1x.png 1x`);
    expect(html).toContain(`${PREFIX}/b-2x.png 2x 600w`);
  });

  it('同一份文件里改一个、留一个（外链不能跟着一起加前缀）', async () => {
    const { dir, outcome } = await rewrite([
      {
        content:
          '<!doctype html><img src="/local.png"><img src="//cdn.example.com/remote.png">' +
          '<img src="data:image/gif;base64,R0lGOD"><link href="/a.css">',
        name: 'index.html',
      },
    ]);
    expect(outcome.html).toBe(2);
    const html = await read(dir, 'index.html');
    expect(html).toContain(`src="${PREFIX}/local.png"`);
    expect(html).toContain('href="/p/crm/crm-p01/a.css"');
    expect(html).toContain('src="//cdn.example.com/remote.png"');
    expect(html).toContain('src="data:image/gif;base64,R0lGOD"');
  });

  it('大小写后缀都算 HTML（Windows 导出的 INDEX.HTM）', async () => {
    const { dir, outcome } = await rewrite([
      { content: '<img src="/a.png">', name: 'INDEX.HTM' },
    ]);
    expect(outcome.html).toBe(1);
    expect(await read(dir, 'INDEX.HTM')).toContain(`${PREFIX}/a.png`);
  });

  it.each([
    ['协议相对外链', '//cdn.example.com/vue.js'],
    ['data URL', 'data:image/svg+xml,<svg/>'],
    ['http 外链', 'http://example.com/a.js'],
    ['https 外链', 'https://cdn.example.com/a.css'],
    ['相对路径', 'assets/app.css'],
    ['同级相对', './local.js'],
    ['上一级相对', '../shared/app.css'],
    ['锚点', '#section-2'],
    ['查询串开头', '?tab=1'],
    ['mailto', 'mailto:pm@example.com'],
    ['空值', ''],
  ])('不改：%s（§2.6 表格"以单个 / 开头且不以 // 开头"）', async (_label, value) => {
    const source = `<img src="${value}" href-x="">`;
    const { dir, outcome } = await rewrite([
      { content: `<!doctype html><a href="${value}">${source}</a>`, name: 'index.html' },
    ]);
    expect(outcome.html).toBe(0);
    // 一处没改 ⇒ 不回写：文件字节必须与写入时完全一致（连 doctype 大小写都不动）。
    expect(await read(dir, 'index.html')).toBe(`<!doctype html><a href="${value}">${source}</a>`);
  });

  it('内联 <script> 的 JS 内容原样保留（约束 1：不碰 JS）', async () => {
    const script = 'var s = "<b>bold</b>"; if (a < b && c > d) { fetch("/api/x") }';
    const { dir, outcome } = await rewrite([
      {
        content: `<!doctype html><script>${script}</script><img src="/a.png">`,
        name: 'index.html',
      },
    ]);
    // 只改了 img 那一处；脚本里的 `fetch("/api/x")` 是原型的业务行为，§2.6 明令不动。
    expect(outcome.html).toBe(1);
    expect(await read(dir, 'index.html')).toContain(`<script>${script}</script>`);
  });

  it('独立 .js 文件根本不进解析器，也不计入条数', async () => {
    const original = 'const url = "/api/login"; fetch(url);\n';
    const { dir, outcome } = await rewrite([
      { content: original, name: 'app.js' },
      { content: '<script src="/app.js"></script>', name: 'index.html' },
    ]);
    expect(outcome.html).toBe(1);
    expect(outcome.css).toBe(0);
    expect(await read(dir, 'app.js')).toBe(original);
    // 指向本地 JS 的 src 仍然要加前缀，否则 404（改的是 HTML 里的引用，不是 JS 内容）。
    expect(await read(dir, 'index.html')).toContain(`src="${PREFIX}/app.js"`);
  });

  it('含 <base href> 的文件整份不改，只记 BASE_TAG_FOUND（约束 2）', async () => {
    const original = '<!doctype html><head><base href="/proto/"></head><img src="/a.png">';
    const { dir, outcome } = await rewrite([
      { content: original, name: 'index.html' },
      { content: '<img src="/b.png">', name: 'other.html' },
    ]);
    expect(outcome.html).toBe(1);
    expect(warningCodes(outcome)).toEqual([UPLOAD_WARNING_CODES.BASE_TAG_FOUND]);
    expect(outcome.warnings[0]?.message).toContain('index.html');
    expect(await read(dir, 'index.html')).toBe(original);
    expect(await read(dir, 'other.html')).toContain(`${PREFIX}/b.png`);
  });

  it('HTML 的 base 不影响 CSS 的 url() 改写（base 只改文档基准，CSS 的基准是它自己）', async () => {
    const { dir, outcome } = await rewrite([
      { content: '<head><base href="/"></head><link href="/a.css">', name: 'index.html' },
      { content: '.x{background:url(/bg.png)}', name: 'a.css' },
    ]);
    expect(outcome.html).toBe(0);
    expect(outcome.css).toBe(1);
    expect(await read(dir, 'a.css')).toContain(`url(${PREFIX}/bg.png)`);
  });

  it('同一码的警告聚合成一条并带 count', async () => {
    const { outcome } = await rewrite([
      { content: '<base href="/"><img src="/a.png">', name: 'a.html' },
      { content: '<base href="/x/"><img src="/b.png">', name: 'b.html' },
      { content: '<base href="/y/"><img src="/c.png">', name: 'c.html' },
    ]);
    expect(outcome.warnings).toHaveLength(1);
    const warning = outcome.warnings[0];
    expect(warning?.count).toBe(3);
    expect(warning?.message).toContain('同类共 3 处');
    expect(outcome.html).toBe(0);
  });
});

describe('CSS url() 改写（§2.6 表格第二行）', () => {
  it('根绝对 url 加前缀，引号形式保持原样', async () => {
    const { dir, outcome } = await rewrite([
      {
        content:
          '@font-face{src:url(/fonts/a.woff2) format("woff2")}\n' +
          '.bg{background:url("/img/b.png") no-repeat}\n' +
          '.c::after{content:"";mask:linear-gradient(url(/img/c.svg),url(/img/d.svg))}',
        name: 'app.css',
      },
    ]);
    expect(outcome.css).toBe(4);
    const written = await read(dir, 'app.css');
    expect(written).toContain(`url(${PREFIX}/fonts/a.woff2)`);
    expect(written).toContain(`url("${PREFIX}/img/b.png")`);
    expect(written).toContain(`url(${PREFIX}/img/c.svg)`);
    expect(written).toContain(`url(${PREFIX}/img/d.svg)`);
  });

  it.each([
    ['url(//fonts.x.com/a.woff)', '协议相对'],
    ['url(data:image/png;base64,AAAA)', 'data URL'],
    ['url(http://a.com/x.png)', 'http 外链'],
    ['url("https://a.com/x.png")', 'https 带引号'],
    ['url(../rel/x.png)', '相对路径'],
    ['url(x.png)', '同级相对'],
  ])('不改：%s（%s）', async (decl, _label) => {
    const original = `.a{background:${decl}}`;
    const { dir, outcome } = await rewrite([
      { content: original, name: 'a.css' },
      { content: '.b{background:none}', name: 'b.css' },
    ]);
    expect(outcome.css).toBe(0);
    expect(await read(dir, 'a.css')).toBe(original);
  });

  it('函数名大写也要改（实测 postcss-value-parser 只给小写 url( 开专用分支，大写会落进通用解析）', async () => {
    const { dir, outcome } = await rewrite([
      {
        content:
          '.a{background:URL(/x.png)}\n.b{background:url( /y.png )}\n.c{background:URL(/deep/sub/z.png)}',
        name: 'a.css',
      },
    ]);
    expect(outcome.css).toBe(3);
    const written = await read(dir, 'a.css');
    // 函数名的原有大小写不动，只换路径。
    expect(written).toContain('URL(/p/crm/crm-p01/x.png)');
    expect(written).toContain('URL(/p/crm/crm-p01/deep/sub/z.png)');
    expect(written).toContain('url( /p/crm/crm-p01/y.png )');
  });

  it('大写函数名指向外链时不动（拆开的载荷要先还原成文本再判一次）', async () => {
    const original = '.a{background:URL(//cdn.example.com/x.png)}\n.b{background:URL(rel/y.png)}';
    const { dir, outcome } = await rewrite([{ content: original, name: 'a.css' }]);
    expect(outcome.css).toBe(0);
    expect(await read(dir, 'a.css')).toBe(original);
  });

  it('非 CSS/HTML 后缀不改', async () => {
    const original = 'a{background:url(/x.png)}';
    const { dir, outcome } = await rewrite([
      { content: original, name: 'styles.scss' },
      { content: original, name: 'notes.txt' },
    ]);
    expect(outcome.css).toBe(0);
    expect(outcome.html).toBe(0);
    expect(await read(dir, 'styles.scss')).toBe(original);
  });
});

describe('失败与性能保护（约束 3 + §2.6 性能保护）', () => {
  it('CSS 解析不了时记 REWRITE_SKIPPED、原文件不动，同批其它文件照改（约束 3）', async () => {
    const broken = '.a{background:url(/x.png)';
    const { dir, outcome } = await rewrite([
      { content: broken, name: 'broken.css' },
      { content: '<img src="/a.png">', name: 'index.html' },
    ]);
    expect(warningCodes(outcome)).toEqual([UPLOAD_WARNING_CODES.REWRITE_SKIPPED]);
    expect(outcome.warnings[0]?.message).toContain('broken.css');
    // 报告里要带上原始报错，否则 §8.2 要求的"指向具体原因"只剩半句（不钉死解析器的措辞）。
    expect(outcome.warnings[0]?.message.length).toBeGreaterThan(
      `文件 "broken.css" 改写失败，已按原样发布：`.length,
    );
    expect(outcome.css).toBe(0);
    expect(outcome.html).toBe(1);
    expect(await read(dir, 'broken.css')).toBe(broken);
    expect(await read(dir, 'index.html')).toContain(`${PREFIX}/a.png`);
  });

  it('清单里有、盘上没有：上抛，不伪装成"已按原样发布"', async () => {
    const dir = await workDirWith([{ content: '<img src="/a.png">', name: 'index.html' }]);
    await expect(
      rewriteRootAbsolutePaths({
        files: [
          { name: 'index.html', sizeBytes: 21 },
          { name: 'ghost.html', sizeBytes: 16 },
        ],
        prefixPath: PREFIX,
        workDir: dir,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('单文件 >5MB 跳过改写并记 REWRITE_TOO_LARGE，文件原样保留', async () => {
    const pad = 'x'.repeat(REWRITE_MAX_FILE_BYTES);
    const original = `<img src="/a.png"><!-- ${pad} -->`;
    const { dir, outcome } = await rewrite([
      { content: original, name: 'big.html' },
      { content: '<a href="/b.css">ok</a>', name: 'ok.html' },
    ]);
    expect(warningCodes(outcome)).toEqual([UPLOAD_WARNING_CODES.REWRITE_TOO_LARGE]);
    // 警告里要指得出是哪个文件、多大，否则 §8.2 的"指向具体原因"缺半句。
    expect(outcome.warnings[0]?.message).toContain('big.html');
    expect(outcome.html).toBe(1);
    expect(await read(dir, 'big.html')).toBe(original);
    expect(await read(dir, 'ok.html')).toContain(`href="${PREFIX}/b.css"`);
  });

  it('跳过判定看磁盘实际字节，不看清单声明值', async () => {
    const pad = 'x'.repeat(REWRITE_MAX_FILE_BYTES + 1);
    const original = `<a href="/b.css">${pad}</a>`;
    const dir = await workDirWith([{ content: original, name: 'a.html' }]);
    const outcome = await rewriteRootAbsolutePaths({
      // 清单谎报成 1KB：磁盘上真的超了，仍然要跳过（不进解析器才是这条规则的目的）。
      files: [{ name: 'a.html', sizeBytes: 1024 }],
      prefixPath: PREFIX,
      workDir: dir,
    });
    expect(warningCodes(outcome)).toEqual([UPLOAD_WARNING_CODES.REWRITE_TOO_LARGE]);
    expect(await read(dir, 'a.html')).toBe(original);
  });
});

describe('纯函数：前缀判定与 srcset', () => {
  it.each([
    ['/assets/app.js', `${PREFIX}/assets/app.js`],
    ['/', `${PREFIX}/`],
  ])('prefixIfRootAbsolute(%s) → %s', (value, expected) => {
    expect(prefixIfRootAbsolute(value, PREFIX)).toBe(expected);
  });

  it.each([
    '//cdn.example.com/a.js',
    'assets/a.js',
    './a.js',
    'data:image/png;base64,AA',
    'http://a.com/x',
    'https://a.com/x',
    '#top',
    '?q=1',
    '',
  ])('prefixIfRootAbsolute(%s) → null（不动）', (value) => {
    expect(prefixIfRootAbsolute(value, PREFIX)).toBeNull();
  });

  it('rewriteSrcset：混合列表只改根绝对的那几段', () => {
    const result = rewriteSrcset('/a.png 1x, //cdn/b.png 2x, c.png 3x', PREFIX);
    expect(result.changed).toBe(1);
    expect(result.value).toBe(`${PREFIX}/a.png 1x, //cdn/b.png 2x, c.png 3x`);
  });

  it('rewriteSrcset：一处都没改时原样返回，连空白都不重排（配合"没改就不回写"）', () => {
    const original = ' //cdn/a.png 1x,  b.png   2x ';
    expect(rewriteSrcset(original, PREFIX)).toEqual({ changed: 0, value: original });
  });

  it('rewriteSrcset：全列表都要改时只换 URL，分隔符与空白原样保留', () => {
    const result = rewriteSrcset('/a.png 1x,/b.png 2x', PREFIX);
    expect(result.changed).toBe(2);
    expect(result.value).toBe(`${PREFIX}/a.png 1x,${PREFIX}/b.png 2x`);
  });

  it('rewriteSrcset：空段与尾逗号不产生半个 URL', () => {
    const result = rewriteSrcset('/a.png,', PREFIX);
    expect(result.changed).toBe(1);
    expect(result.value).toBe(`${PREFIX}/a.png,`);
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('改写的确定性', () => {
  it('同一份输入跑两遍得到同一份字节（重复发布指纹必须稳定）', async () => {
    const files = [
      { content: '<img src="/a.png" srcset="/b.png 2x">', name: 'index.html' },
      { content: '.a{background:url(/c.png)}', name: 'app.css' },
    ];
    const first = await rewrite(files);
    const second = await rewrite(files);
    expect(sha256(`${await read(first.dir, 'index.html')}|${await read(first.dir, 'app.css')}`)).toBe(
      sha256(`${await read(second.dir, 'index.html')}|${await read(second.dir, 'app.css')}`),
    );
    expect(second.outcome).toEqual(first.outcome);
  });
});

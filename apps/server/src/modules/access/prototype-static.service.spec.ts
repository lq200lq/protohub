import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import type { AccessReason } from '@protohub/shared';

import { CookieService } from '../../common/permission/cookie.service';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import { LocalStorageAdapter } from '../storage/local-storage.adapter';
import type { AccessOutcome, AccessQuery, AccessService } from './access.service';
import {
  PrototypeStaticService,
  type StaticRequest,
  type StaticResponse,
} from './prototype-static.service';

/**
 * Node 直出（迭代实施计划 M4-T4/T5；机制 §5、§7；部署方案 §5 的 nginx 段是它的对照物）。
 *
 * 存储用**真的** `LocalStorageAdapter` + 临时目录里的真文件：路径不能越出 `STORAGE_ROOT`
 * 这件事由它的 `localPathOf()` 负责，桩掉它这条防线就没人在测了。测试产物只落在
 * `mkdtemp(tmpdir())` 下，绝不碰开发用的 `~/protohub-storage`。
 * 只桩 `AccessService.decide`——判定本身在 `decide-access.spec.ts` 里穷举过，这里要钉的是
 * "直出入口拿到判定之后做什么"。
 */

const INDEX_HTML = '<!doctype html><title>原型首页</title>';
const APP_JS = 'console.log(1)';
const SPACE_JS = 'console.log("space")';
const DATA_BIN = 'binary-ish';
const DOTFILE_SECRET = 'MUST_NOT_SERVE';

/** 版本目录：`releases/{项目ID}/{原型ID}/{版本ID}`，与 `releaseFileKey()` 同一形状。 */
const RELATIVE_RELEASE = join('releases', '6', '10', '15');

let ROOT = '';

function releaseDir(...parts: string[]): string {
  return join(ROOT, RELATIVE_RELEASE, ...parts);
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'protohub-static-'));
  await mkdir(join(ROOT, RELATIVE_RELEASE, 'assets'), { recursive: true });
  await mkdir(join(ROOT, RELATIVE_RELEASE, 'pages'), { recursive: true });
  await writeFile(releaseDir('index.html'), INDEX_HTML);
  await writeFile(releaseDir('assets', 'app.js'), APP_JS);
  // 文件名带空格：产物里引用它时必然写成 `my%20page.js`，这一条就是"本地与 nginx 同口径"的判据
  await writeFile(releaseDir('assets', 'my page.js'), SPACE_JS);
  await writeFile(releaseDir('assets', 'data.bin'), DATA_BIN);
  await writeFile(releaseDir('.env'), DOTFILE_SECRET);
});

afterAll(async () => {
  await rm(ROOT, { force: true, recursive: true });
});

function allowed(releaseId = '15'): AccessOutcome {
  return {
    decision: { releaseId, status: 200 },
    projectId: '6',
    prototypeId: '10',
    sessionUserId: null,
  };
}

function denied(reason: AccessReason, status: 401 | 403 | 404): AccessOutcome {
  return { decision: { reason, status }, projectId: '6', prototypeId: '10', sessionUserId: null };
}

type Decider = (query: AccessQuery) => AccessOutcome;

interface Harness {
  decide: Mock<(query: AccessQuery) => Promise<AccessOutcome>>;
  serve: (url: string, headers?: Record<string, unknown>) => Promise<StaticResponse>;
}

function harness(outcome: AccessOutcome | Decider): Harness {
  const env = fakeAppEnv({ PUBLIC_BASE_URL: 'http://127.0.0.1:3100', STORAGE_ROOT: ROOT });
  const decide = vi.fn(async (query: AccessQuery) =>
    typeof outcome === 'function' ? outcome(query) : outcome,
  );
  const service = new PrototypeStaticService(
    new LocalStorageAdapter(env),
    { decide } as unknown as AccessService,
    new CookieService(env),
    env,
  );
  return {
    decide,
    serve: (url, headers = {}) => service.serve({ headers, url } as unknown as StaticRequest),
  };
}

describe('URL 形态（先于任何决策）', () => {
  it('单段 /p/crm → 404 门面页，不查库（G6：不能落到管理台 SPA）', async () => {
    const { decide, serve } = harness(allowed());
    const { body, status } = await serve('/p/crm');

    expect(decide).not.toHaveBeenCalled();
    expect(status).toBe(404);
    expect(body).toContain('链接无效或已失效');
    expect(body).toContain('<!doctype html>');
  });

  it.each([
    ['/p/crm/crm-p01', '/p/crm/crm-p01/'],
    ['/p/crm/crm-p01?x=1', '/p/crm/crm-p01/?x=1'],
  ])('%s → 301 到 %s（少一个尾斜杠会让产物里的相对路径指错位置）', async (url, location) => {
    const { decide, serve } = harness(allowed());
    const { headers, status } = await serve(url);

    expect(status).toBe(301);
    expect(headers.Location).toBe(location);
    // 与部署方案 §5 那条 `return 301` 一样：跳转发生在鉴权之前，编码本来就在访问者手里
    expect(decide).not.toHaveBeenCalled();
  });

  it('资源路径少斜杠不跳转（那是文件名的一部分）', async () => {
    const { headers, status } = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');

    expect(status).toBe(200);
    expect(headers.Location).toBeUndefined();
  });

  it('子目录带尾斜杠走默认文档，不带斜杠按 nginx 给 403', async () => {
    const nested = await harness(allowed()).serve('/p/crm/crm-p01/assets/');
    expect(nested.status).toBe(404); // 该子目录里没有 index.html：与 nginx 的 404 同一条

    const bare = await harness(allowed()).serve('/p/crm/crm-p01/assets');
    expect(bare.status).toBe(403); // 目录当文件发：nginx 的 static 处理器在这里给 FORBIDDEN
  });
});

describe('路径先归一再查文件（nginx 的 URI 规范化在 location 匹配之前）', () => {
  it('%20 形态的文件名能查到——本地直出与线上 nginx 必须给同一个答案', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/my%20page.js');

    expect(result.status).toBe(200);
    expect(result.filePath).toBe(releaseDir('assets', 'my page.js'));
  });

  it('目录内的 .. 先归一再查：/assets/../index.html 就是 index.html', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/../index.html');

    expect(result.status).toBe(200);
    expect(result.filePath).toBe(releaseDir('index.html'));
  });

  it('越出版本目录的三种形态都 404，且没有 filePath 交出去', async () => {
    for (const url of [
      '/p/crm/crm-p01/../../etc/passwd',
      '/p/crm/crm-p01/%2E%2E%2F%2E%2E%2Fetc/passwd',
      '/p/crm/crm-p01/%2Fetc%2Fpasswd',
    ]) {
      const result = await harness(allowed()).serve(url);

      expect(result.filePath).toBeUndefined();
      expect([404, 403]).toContain(result.status);
      expect(result.body).toContain('<!doctype html>');
    }
  });

  it('畸形百分号转义按"不存在"处理，不是 500', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/app%ZZ.js');

    expect(result.status).toBe(404);
  });
});

describe('放行后的响应头（Gate G7 的 `curl -I` 判据）', () => {
  it('目录根 → 默认文档 index.html：HTML 一律 no-store', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/');

    expect(result.status).toBe(200);
    expect(result.filePath).toBe(releaseDir('index.html'));
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(result.headers['Content-Length']).toBe(String(Buffer.byteLength(INDEX_HTML)));
    expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(result.headers.ETag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(result.headers['Last-Modified']).toMatch(/GMT$/);
  });

  it('显式的 /index.html 与目录根是同一条，缓存头也一样', async () => {
    const direct = await harness(allowed()).serve('/p/crm/crm-p01/index.html');

    expect(direct.status).toBe(200);
    expect(direct.filePath).toBe(releaseDir('index.html'));
    expect(direct.headers['Cache-Control']).toBe('no-store');
  });

  it('带查询串的 HTML 仍然 no-store（判据作用在原始 URI 上，与 nginx 的 map 同形）', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/index.html?v=2');

    expect(result.headers['Cache-Control']).toBe('no-store');
  });

  it('资源 → no-cache，且不把 .js 当成 HTML', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');

    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-cache');
    expect(result.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(result.headers['Content-Length']).toBe(String(Buffer.byteLength(APP_JS)));
  });

  it('认不出的扩展名走 octet-stream：宁可让浏览器下载，也不要猜一个让它执行', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/data.bin');

    expect(result.status).toBe(200);
    expect(result.headers['Content-Type']).toBe('application/octet-stream');
    // no-cache 而没带 ETag 就等于每次都全量重取，这两条是一套的
    expect(result.headers.ETag).toBeDefined();
  });
});

describe('条件请求（no-cache 的另一半：内容没变就走 304）', () => {
  it('If-None-Match 命中 → 304，且不再带 Content-Length/Content-Type', async () => {
    const first = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');
    const etag = String(first.headers.ETag);

    const second = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-none-match': etag,
    });

    expect(second.status).toBe(304);
    expect(second.body).toBeUndefined();
    expect(second.filePath).toBeUndefined();
    expect(second.headers['Content-Length']).toBeUndefined();
    expect(second.headers['Content-Type']).toBeUndefined();
    expect(second.headers.ETag).toBe(etag);
    expect(second.headers['Cache-Control']).toBe('no-cache');
  });

  it('弱标记与多标签列表都要能命中（代理可能把强标签降级成 W/）', async () => {
    const first = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');
    const etag = String(first.headers.ETag);

    const weak = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-none-match': `W/${etag}`,
    });
    const listed = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-none-match': `"other", ${etag}`,
    });

    expect(weak.status).toBe(304);
    expect(listed.status).toBe(304);
  });

  it('标签不同 → 200 发全量', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-none-match': '"deadbeef-0"',
    });

    expect(result.status).toBe(200);
    expect(result.filePath).toBeDefined();
  });

  it('Last-Modified 之后与之前：同一秒就 304，早一秒是 200', async () => {
    const first = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');
    const stamp = String(first.headers['Last-Modified']);
    const earlier = new Date(new Date(stamp).getTime() - 1000).toUTCString();

    const same = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-modified-since': stamp,
    });
    const older = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-modified-since': earlier,
    });

    expect(same.status).toBe(304);
    expect(older.status).toBe(200);
  });

  it('If-Modified-Since 是畸形日期时按"没带这个头"处理：宁可多发一份，也不 304 掉新内容', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js', {
      'if-modified-since': 'not-a-date',
    });

    expect(result.status).toBe(200);
  });
});

describe('点文件拒绝（§7 表第三行；nginx 侧是 location ~ /\\.）', () => {
  it('目录里的 .env 不给读，403 + 兜底形态', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/.env');

    expect(result.status).toBe(403);
    expect(result.filePath).toBeUndefined();
    expect(result.body).toContain('该原型暂时无法访问');
    expect(result.body).not.toContain(DOTFILE_SECRET);
  });

  it('%2E 形态与中间段的点目录同样拒绝（解码后判定，不给绕过口）', async () => {
    const encoded = await harness(allowed()).serve('/p/crm/crm-p01/%2Eenv');
    const nested = await harness(allowed()).serve('/p/crm/crm-p01/assets/.git/config');

    expect(encoded.filePath).toBeUndefined();
    expect(nested.filePath).toBeUndefined();
    expect(encoded.status).toBe(403);
    expect(nested.status).toBe(403);
  });

  it('点文件在决策之后判：要密码的原型里的点文件仍是 401 密码页，不提前暴露"这个路径存在"', async () => {
    const result = await harness(denied('NEED_PASSWORD', 401)).serve('/p/crm/crm-p01/.env');

    expect(result.status).toBe(401);
    expect(result.body).toContain('该原型需要访问密码');
  });
});

describe('文件不存在 / 是目录', () => {
  it('资源缺失 → 404 门面页（生产里这条也会被 error_page 404 接住，同一个页面）', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/missing.js');

    expect(result.status).toBe(404);
    expect(result.body).toContain('链接无效或已失效');
  });

  it('发布目录里没有 index.html 的入口请求 → 404，不是 500', async () => {
    const result = await harness(allowed('999')).serve('/p/crm/crm-p01/');

    expect(result.status).toBe(404);
    expect(result.filePath).toBeUndefined();
  });

  it('版本目录整个不存在（决策与磁盘不一致）→ 404', async () => {
    const result = await harness(allowed('12345')).serve('/p/crm/crm-p01/index.html');

    expect(result.status).toBe(404);
  });

  it('三个 id 有一个不是数字就出不了目录：404，不出现第五种状态码', async () => {
    const result = await harness({
      ...allowed(),
      projectId: '6; DROP',
    }).serve('/p/crm/crm-p01/');

    expect(result.status).toBe(404);
    expect(result.filePath).toBeUndefined();
  });
});

describe('决策不通过时：状态码与形态一起给（G5）', () => {
  it.each([
    ['NEED_PASSWORD', 401, '该原型需要访问密码'],
    ['NEED_LOGIN', 403, '该原型仅限内部成员查看'],
    ['NO_PERMISSION', 403, '你没有查看该原型的权限'],
    ['PROTOTYPE_ARCHIVED', 403, '该原型已下架'],
    ['PROJECT_ARCHIVED', 403, '该原型所属项目已下架'],
    ['NOT_FOUND', 404, '链接无效或已失效'],
    ['NOT_PUBLISHED', 404, '链接无效或已失效'],
  ] as const)('%s → %d %s', async (reason, status, copy) => {
    const result = await harness(denied(reason, status)).serve('/p/crm/crm-p01/');

    expect(result.status).toBe(status);
    expect(result.filePath).toBeUndefined();
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(result.body).toContain(copy);
  });

  it('NEED_LOGIN 的门面页带上回来的地址，密码表单指向 unlock', async () => {
    const login = await harness(denied('NEED_LOGIN', 403)).serve('/p/crm/crm-p01/pages/a.html');
    const password = await harness(denied('NEED_PASSWORD', 401)).serve('/p/crm/crm-p01/');

    expect(login.body).toContain(
      'href="http://127.0.0.1:3100/auth/login?redirect=%2Fp%2Fcrm%2Fcrm-p01%2Fpages%2Fa.html"',
    );
    expect(password.body).toContain('action="/api/access/crm/crm-p01/unlock"');
  });

  it('直出入口不显示项目名与原型名（G9 与门面页同一条判据）', async () => {
    const result = await harness(denied('NOT_FOUND', 404)).serve('/p/probe/probe-project/');

    expect(result.status).toBe(404);
    expect(result.body).not.toContain('probe');
  });

  it('决策说 200 却没有版本目录 → 404，不出现第五种状态码', async () => {
    const result = await harness({
      ...allowed(),
      prototypeId: null,
    }).serve('/p/crm/crm-p01/');

    expect(result.status).toBe(404);
  });
});

describe('凭据只从 Cookie 走（与 /api/access/check 同一个入口口径）', () => {
  it('query 里的 token 不是凭据；headers.cookie 才是', async () => {
    const seen: string[] = [];
    const { decide, serve } = harness((query) => {
      seen.push(
        String(query.readCookie('proto_sess') ?? ''),
        String(query.readCookie('token') ?? ''),
      );
      return denied('NEED_LOGIN', 403);
    });

    await serve('/p/crm/crm-p01/?token=forged', {
      authorization: 'Bearer forged',
      cookie: 'proto_sess=v1.42.3.9.sig',
    });

    expect(seen).toEqual(['v1.42.3.9.sig', '']);
    expect(decide).toHaveBeenCalledOnce();
  });
});

describe('可记事实 `access`（M4-T9：直出入口没有 gate 那一跳）', () => {
  it('入口放行：把"该记什么"一起交出去，写不写由 recorder 判', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/');

    expect(result.access).toEqual({
      isEntry: true,
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      prototypeId: '10',
      releaseId: '15',
      userId: null,
    });
  });

  it('资源请求也带，只是 isEntry=false：口径不在这里重写第二遍', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/assets/app.js');

    expect(result.access).toMatchObject({ isEntry: false });
  });

  it('member 档判定出的登录用户跟着走', async () => {
    const result = await harness({ ...allowed(), sessionUserId: '42' }).serve('/p/crm/crm-p01/');

    expect(result.access?.userId).toBe('42');
  });

  it('被拒也带：401/403/404 都要进统计，否则"有人打不开"这件事看不见', async () => {
    const denied401 = await harness(denied('NEED_PASSWORD', 401)).serve('/p/crm/crm-p01/');
    const missing = await harness(allowed()).serve('/p/crm/crm-p01/assets/gone.js');

    expect(denied401.access).toMatchObject({ isEntry: true, releaseId: null });
    expect(missing.access).toMatchObject({ isEntry: false });
    expect(missing.status).toBe(404);
  });

  it('点文件那一发 403 也带事实（本地比 nginx 多记的一档，见迭代实施计划 §9.2）', async () => {
    const result = await harness(allowed()).serve('/p/crm/crm-p01/.env');

    expect(result.status).toBe(403);
    expect(result.access).toMatchObject({ isEntry: false, prototypeId: '10' });
  });

  it.each([
    ['301 补尾斜杠', '/p/crm/crm-p01'],
    ['单段 /p/crm（还没解析出两级编码）', '/p/crm'],
    ['畸形编码（同上）', '/p/crm/../etc'],
  ] as const)('%s → 没有事实可记', async (_label, url) => {
    const result = await harness(allowed()).serve(url);

    expect(result.access).toBeUndefined();
  });

  it('304 没有 body，也就没有第二次"有人访问了"', async () => {
    const { serve } = harness(allowed());
    const first = await serve('/p/crm/crm-p01/assets/app.js');
    const etag = first.headers.ETag;
    if (etag === undefined) {
      throw new Error('没拿到实体标签');
    }

    const again = await serve('/p/crm/crm-p01/assets/app.js', { 'if-none-match': etag });

    expect(again.status).toBe(304);
    expect(again.access).toBeUndefined();
  });
});

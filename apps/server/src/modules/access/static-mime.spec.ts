import { describe, expect, it } from 'vitest';

import { contentTypeOf, isHtmlUri } from './static-mime';

/**
 * 直出的类型表与 HTML 分类（迭代实施计划 M4-T5；机制 §7 的缓存头表）。
 *
 * 这两条各有一个"错了就看不见"的失败模式：类型猜错 = 原型里的脚本不执行或中文乱码；
 * HTML 分类错 = 权限改动后浏览器还在发旧页面（计划里的 F-8）。所以它们从直出流程里拆出来单验。
 */

describe('contentTypeOf：只认扩展名', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['pages/detail.htm', 'text/html; charset=utf-8'],
    ['assets/app.js', 'text/javascript; charset=utf-8'],
    ['assets/module.mjs', 'text/javascript; charset=utf-8'],
    ['assets/base.css', 'text/css; charset=utf-8'],
    ['assets/app.js.map', 'application/json; charset=utf-8'],
    ['icon.svg', 'image/svg+xml'],
    ['favicon.ico', 'image/x-icon'],
    ['fonts/body.woff2', 'font/woff2'],
    ['media/clip.mp4', 'video/mp4'],
    ['site.webmanifest', 'application/manifest+json'],
    // 扩展名大写与路径里带点都不能影响判定（产物名由上传方决定）
    ['ASSETS/APP.JS', 'text/javascript; charset=utf-8'],
    ['v1.2/index.html', 'text/html; charset=utf-8'],
  ])('%s → %s', (path, type) => {
    expect(contentTypeOf(path)).toBe(type);
  });

  it('文本类一律带 charset（缺了它，原型里的中文注释在 Safari 上就是乱码）', () => {
    for (const path of ['a.css', 'a.html', 'a.js', 'a.json', 'a.txt', 'a.xml']) {
      expect(contentTypeOf(path)).toMatch(/charset=utf-8$/);
    }
  });

  it.each([
    'assets/data.bin',
    'assets/no-extension',
    'assets/archive.zip',
    'assets/page.php',
    'nested/deep/file.unknown',
  ])('认不出的 %s → application/octet-stream：让浏览器下载，不猜一个让它执行', (path) => {
    expect(contentTypeOf(path)).toBe('application/octet-stream');
  });

  it('点文件与无扩展名的裸名都落到兜底，不会被当成 HTML', () => {
    expect(contentTypeOf('.env')).toBe('application/octet-stream');
    expect(contentTypeOf('index')).toBe('application/octet-stream');
  });
});

describe('isHtmlUri：与部署方案 §5 那张 nginx map 逐条同形', () => {
  /**
   * 对照物：`map $request_uri $proto_cache_control`。第二条（目录写法）是这次补的——
   * 原设计只有扩展名一条，于是最常用的入口链接 `/p/{项目}/{原型}/` 会落到 `no-cache`，
   * 而它发的是 `index.html`（见 `isHtmlUri` 的注释与计划 §9.2 DEV-31）。
   */
  const NGINX_MAP: ReadonlyArray<readonly [RegExp, string]> = [
    [/\.(html?|htm)(\?|$|#)/i, 'no-store'],
    [/\/(\?|$|#)/i, 'no-store'],
  ];

  function nginxCacheControl(uri: string): string {
    for (const [pattern, value] of NGINX_MAP) {
      if (pattern.test(uri)) {
        return value;
      }
    }
    return 'no-cache';
  }

  it.each([
    '/p/crm/crm-p01/',
    '/p/crm/crm-p01/?x=1',
    '/p/crm/crm-p01/pages/',
    '/p/crm/crm-p01/index.html',
    '/p/crm/crm-p01/index.HTML',
    '/p/crm/crm-p01/pages/detail.html?v=2',
    '/p/crm/crm-p01/a.htm#top',
    '/p/crm/crm-p01/assets/app.js',
    '/p/crm/crm-p01/assets/app.js?v=2',
    '/p/crm/crm-p01/index.html.bak',
    // `%2E` 形态在 nginx 的 map 里同样不构成扩展名，也不是目录写法：两边都是 no-cache
    '/p/crm/crm-p01/index%2Ehtml',
    '/p/crm/crm-p01/html',
    '',
  ])('%s：JS 与 nginx map 给出同一个缓存头', (uri) => {
    expect(isHtmlUri(uri) ? 'no-store' : 'no-cache').toBe(nginxCacheControl(uri));
  });

  it('入口的两种写法都是 HTML：目录根发的是默认文档，不是"某个未知资源"', () => {
    expect(isHtmlUri('/p/crm/crm-p01/')).toBe(true);
    expect(isHtmlUri('/p/crm/crm-p01/index.html')).toBe(true);
    expect(isHtmlUri('/p/crm/crm-p01/assets/app.js')).toBe(false);
  });
});

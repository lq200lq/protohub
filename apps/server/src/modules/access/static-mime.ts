/**
 * 静态直出的 MIME 表（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §7；
 * 迭代实施计划 M4-T5）。
 *
 * 为什么不复用 `@fastify/static`（它在依赖里）：它的 `root` 在注册时就固定，而直出的根目录是
 * **每次请求由访问决策算出来的**（`releases/{项目ID}/{原型ID}/{版本ID}`），插件形态
 * （`prefix` + 静态 root）与"编码 → 版本目录"这条映射不匹配。类型表同理——
 * Node 的 `fs` 没有内建 MIME，装 `mime` 又在 §3.2 白名单外。
 *
 * 表只覆盖**原型产物里会出现的那几类**（HTML/CSS/JS/图片/字体/媒体/清单），
 * 认不出的一律 `application/octet-stream`：让浏览器下载而不是当脚本执行，
 * 这比猜一个 `text/plain` 更安全，也和 nginx 的默认 `default_type` 同源。
 */

/** 文本类要带 charset：原型里的中文注释没带 charset 就会在 Safari 上乱码。 */
const TEXT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  xml: 'text/xml; charset=utf-8',
};

const BINARY_TYPES: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  eot: 'application/vnd.ms-fontobject',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  otf: 'font/otf',
  png: 'image/png',
  ttf: 'font/ttf',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

const FALLBACK_TYPE = 'application/octet-stream';

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/**
 * 只按扩展名给类型，**不看文件内容**：探测内容（magic）会让一个 `.png` 被当成 HTML 执行，
 * 是 XSS 的来路之一。响应侧配 `X-Content-Type-Options: nosniff` 把这条路堵死。
 */
export function contentTypeOf(relativePath: string): string {
  const extension = extensionOf(relativePath);
  const type = TEXT_TYPES[extension] ?? BINARY_TYPES[extension];
  return type ?? FALLBACK_TYPE;
}

/**
 * HTML 分类（机制 §7 的第一行：HTML `no-store`，其余 `no-cache`）。
 *
 * 两条判据，都作用在**原始 URI** 上：
 * 1. 扩展名是 `.html` 或 `.htm`（`\.(html?|htm)($|[?#])`）；
 * 2. **目录写法**（以 `/` 结尾，可带查询串）——这里发的是版本目录的默认文档 `index.html`，
 *    它是 HTML，而 URI 里没有出现扩展名。
 *
 * 第二条是原设计漏的（M4-T4/T5 实测时发现，计划 §9.2 DEV-31）：部署方案 §5 的 map 原本只写了
 * 扩展名一条，于是 `/p/{项目}/{原型}/` 这条**最常用的入口链接**会落到 `default "no-cache"`——
 * 用户收藏的、分享出去的那条链接恰好是它。计划里的 F-8（"HTML 被缓存"）就是从这儿进来的。
 * 文档已与这两条判据同步，改动时必须两边一起改，否则本地和线上又不同口径（决策 D-05）。
 *
 * 判据刻意不看解析后的路径，与那张 map 逐字符同形：两边算出的缓存头不一样，就会出现
 * "本地不缓存、线上缓存了"这类只在切换时才暴露的差。
 */
export function isHtmlUri(rawUri: string): boolean {
  return /\.(html?|htm)($|[?#])/i.test(rawUri) || /\/(\?|#|$)/.test(rawUri);
}

import { isValidProjectCode, isValidPrototypeCode } from '@protohub/shared';

import { PROTO_ACCESS_PREFIX } from '../../config/constants';

/**
 * 从 `X-Original-URI` 里解析两级编码（[后端接口设计.md](../../../../../docs/后端接口设计.md) §9.1；
 * 迭代实施计划 M4-T3）。
 *
 * nginx 用 `$request_uri` 填这个头，因为 `proxy_pass` 的固定路径带不上原始 URI。
 * 解析出来的只有**两段编码**，其余部分原样带出：
 * - 两段编码是决策的全部输入（机制 §5.1 的 `target`）；
 * - `resourcePath` 只用来判断"是不是入口文档"（机制 §6 的日志粒度）与直出侧的缓存头分类。
 *
 * 解析失败一律返回 `null`，由调用方给 404：这个接口的取值集合只有 200/401/403/404（§9.1 的头表），
 * 多一个状态码 nginx 就得多加一条 `error_page` 映射。
 */
export interface AccessTarget {
  readonly projectCode: string;
  readonly prototypeCode: string;
  /** 版本目录内的剩余路径，形如 `/assets/app.js`；目录根（`/p/crm/crm-p01/`）是空串。 */
  readonly resourcePath: string;
}

/** 只截路径部分：`?` 之后是查询串，`#` 之后浏览器根本不会发给 nginx。 */
function pathOnly(raw: string): string {
  const withoutQuery = raw.split('?')[0] ?? raw;
  return withoutQuery.split('#')[0] ?? withoutQuery;
}

/**
 * `%2F` 之类的转义要先解开才能比对编码，但解开后可能带出 `/`——
 * 所以解码后仍走一遍 `isValidProjectCode`/`isValidPrototypeCode`（字符集里根本没有 `/` 和 `.`），
 * 路径穿越在这一步就出不去了。
 */
function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // 非法百分号转义（`%ZZ`）：畸形请求，按不存在处理
    return null;
  }
}

export function parseAccessUri(raw: string | undefined): AccessTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const path = pathOnly(trimmed);
  const prefix = `${PROTO_ACCESS_PREFIX}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const segments = path.slice(prefix.length).split('/');
  // 只允许一个尾空段（`/p/crm/crm-p01/` 这种目录根写法）；中间出现空段说明 URI 畸形，
  // 而 nginx 的 location 前缀匹配与我们这里取的前两段就不再是同一个原型，宁可不放行。
  if (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  if (segments.length < 2 || segments.some((segment) => segment === '')) {
    return null;
  }
  const projectCode = decodeSegment(segments[0] ?? '');
  const prototypeCode = decodeSegment(segments[1] ?? '');
  if (
    projectCode === null ||
    prototypeCode === null ||
    !isValidProjectCode(projectCode) ||
    !isValidPrototypeCode(prototypeCode)
  ) {
    return null;
  }
  const rest = segments.slice(2);
  return {
    projectCode,
    prototypeCode,
    resourcePath: rest.length === 0 ? '' : `/${rest.join('/')}`,
  };
}

/**
 * 入口文档判定（机制 §6：只有入口访问写 `ok` 日志，资源请求写了会让访问量虚高几十倍）。
 * 与直出侧"目录默认文档 = index.html"是同一条规则（机制 §7 的 HTML 分类），所以放在一起。
 */
export function isEntryDocument(target: AccessTarget): boolean {
  return (
    target.resourcePath === '' ||
    target.resourcePath.toLowerCase() === '/index.html'
  );
}

import type { AccessLogResult } from '@protohub/shared';

/**
 * 记录口径（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §6 那张表；
 * 迭代实施计划 M4-T9 的判据「访问 20 次资源不产生 20 条记录；入口请求只 1 条」）。
 *
 * 这张表是全系统**唯一**的"这次访问要不要落库"的判断，三个入口共用它：
 * nginx 模式下的 `/api/access/check`（决策在这里）、`/api/access/gate`（线上唯一能看见
 * "资源 404"的地方）、以及本地 `SERVE_STATIC=node` 的直出路由（三样都在这儿）。
 * 于是"本地记的和线上记的是同一套"（决策 D-05）不需要第二个人核对——它就是同一个函数。
 */

/**
 * 这次请求是不是**入口文档**（`/p/{项目}/{原型}/` 或 `.../index.html`）。
 * 判定本身在 `access-uri.ts` 的 `isEntryDocument()`，与缓存头的 HTML 分类是同一批规则。
 */
export interface VisitShape {
  readonly isEntry: boolean;
  /** 决策/直出给出的最终状态码。 */
  readonly status: number;
}

/**
 * §6 表逐行翻译：
 * - 成功且是入口 → `ok`（"有人访问了这个原型"的唯一真实信号）；
 * - 成功但是资源 → **不记**：一个原型 40 个资源，全记会让 PV 虚高 40 倍；
 * - 401/403 → 对应 denied 值，**资源请求也记**（"有人拿到链接但被拦住"就是要看得见，
 *   这一条是文档明写的例外，不是漏掉了资源过滤）；
 * - 404 → `not_found`（编码不存在、原型已删、发布产物里缺这个文件——三种都在这一列，
 *   靠 `prototype_id` 是否为空区分，见 §6.1 的「无效链接」）；
 * - 其余（301 补尾斜杠、304 协商缓存、500 读盘故障）→ **不记**：301 之后浏览器会带着
 *   正确路径再来一次，那一跳已经计过；304 是同一次浏览的重验，记了就是每次刷新翻倍。
 */
export function accessLogResultOf(visit: VisitShape): AccessLogResult | null {
  switch (visit.status) {
    case 200: {
      return visit.isEntry ? 'ok' : null;
    }
    case 401: {
      return 'denied_401';
    }
    case 403: {
      return 'denied_403';
    }
    case 404: {
      return 'not_found';
    }
    default: {
      return null;
    }
  }
}

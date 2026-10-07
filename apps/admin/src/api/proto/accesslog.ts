import type {
  AccessLogItem,
  AccessLogListQuery,
  AccessLogSummary,
  AccessLogSummaryQuery,
  PageResult,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/**
 * GET /api/access-logs（后端接口设计 §6.1；实现在 apps/server/src/modules/accesslog/access-log.query.controller.ts）。
 *
 * `maskIp` 缺省即"服务端默认打码最后一段"（§6.1 注：`system:log:list` 及以上才可请求明文）。
 * 本页不开明文入口——查看全量 IP 是运维排障动作，不该藏在这张表的默认请求里。
 */
export function getAccessLogsApi(params: AccessLogListQuery) {
  return requestClient.get<PageResult<AccessLogItem>>('/access-logs', {
    params,
  });
}

/**
 * GET /api/access-logs/summary（§6.2）：PV/UV/被拒/爬虫/无效链接 + 按天趋势 + 两张榜。
 * `days` 缺省 7、越界由服务端夹到 1..90（access-log.query.service.ts 的 resolveSummaryDays）。
 */
export function getAccessLogSummaryApi(params: AccessLogSummaryQuery) {
  return requestClient.get<AccessLogSummary>('/access-logs/summary', {
    params,
  });
}

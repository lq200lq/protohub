import type { DashboardOverview } from '@protohub/shared';

import { requestClient } from '#/api/request';

/**
 * GET /api/dashboard/overview（后端接口设计 §3.1；实现在 apps/server/src/modules/dashboard/dashboard.service.ts）。
 * 工作台六块数据一次取回，数字全部受数据权限过滤，前端不做二次加工。
 */
export function getDashboardOverviewApi() {
  return requestClient.get<DashboardOverview>('/dashboard/overview');
}

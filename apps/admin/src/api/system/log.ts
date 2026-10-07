import type {
  LoginLogItem,
  LoginLogQuery,
  OperLogItem,
  OperLogQuery,
  PageResult,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/system/login-logs（§7.5.1） */
export function getLoginLogsApi(params: LoginLogQuery) {
  return requestClient.get<PageResult<LoginLogItem>>('/system/login-logs', {
    params,
  });
}

/** GET /api/system/oper-logs（§7.5.2） */
export function getOperLogsApi(params: OperLogQuery) {
  return requestClient.get<PageResult<OperLogItem>>('/system/oper-logs', {
    params,
  });
}

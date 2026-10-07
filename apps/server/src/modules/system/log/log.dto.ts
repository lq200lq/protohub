import { z } from 'zod';

import {
  optionalQueryBoolean,
  optionalQueryDateTime,
  optionalQueryId,
  optionalQueryText,
} from '../common/dto';

/**
 * 日志查询契约（后端接口设计 §7.5）。
 * 全部 GET query：空白值视为"没填"（common/dto 的 preprocess 约定），分页交给公共归一化。
 */

/** §7.5.1 GET /api/system/login-logs?username=&success=&startTime=&endTime= */
export const loginLogQuerySchema = z.object({
  username: optionalQueryText(50),
  success: optionalQueryBoolean(),
  startTime: optionalQueryDateTime(),
  endTime: optionalQueryDateTime(),
});

/** §7.5.2 GET /api/system/oper-logs?resourceType=&resourceId=&action=&username=&startTime=&endTime= */
export const operLogQuerySchema = z.object({
  resourceType: optionalQueryText(50),
  resourceId: optionalQueryId(),
  action: optionalQueryText(50),
  username: optionalQueryText(50),
  startTime: optionalQueryDateTime(),
  endTime: optionalQueryDateTime(),
});

export type LoginLogFilterInput = z.infer<typeof loginLogQuerySchema>;
export type OperLogFilterInput = z.infer<typeof operLogQuerySchema>;

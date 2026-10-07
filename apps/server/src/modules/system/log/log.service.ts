import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  LOGIN_LOG_TYPES,
  type LoginLogItem,
  type LoginLogType,
  type OperLogItem,
} from '@protohub/shared';

import { PRISMA_CLIENT } from '../persistence/prisma-token';
import {
  toPageData,
  type NormalizedPageQuery,
  type PageData,
} from '../../../common/pagination/pagination';
import type { LoginLogFilterInput, OperLogFilterInput } from './log.dto';

/**
 * 系统管理·日志（后端接口设计 §7.5）。只读查询，写入端在
 * auth/login-log.service.ts（登录）与 system/audit/operation-audit.writer.ts（审计）。
 * 两张日志表都没有软删除列（数据库设计 §4.1.8/§4.1.9），因此无 deleted_at 过滤——按时间倒序分页。
 */

export interface LoginLogRow {
  readonly id: bigint;
  readonly userId: bigint | null;
  readonly username: string;
  readonly loginType: string;
  readonly success: boolean;
  readonly failReason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

export interface OperLogRow {
  readonly id: bigint;
  readonly userId: bigint | null;
  readonly username: string | null;
  readonly module: string;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly resourceName: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly detail: Prisma.JsonValue;
  readonly ip: string | null;
  readonly success: boolean;
  readonly errorMessage: string | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

@Injectable()
export class LogService {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /** §7.5.1 登录日志：username（模糊）/success/时间范围，倒序分页。 */
  async loginLogs(
    filter: LoginLogFilterInput,
    page: NormalizedPageQuery,
  ): Promise<PageData<LoginLogItem>> {
    const where: Prisma.SysLoginLogWhereInput = {
      ...timeRangeWhere(filter),
      ...(filter.success === undefined ? {} : { success: filter.success }),
      ...(filter.username === undefined
        ? {}
        : { username: { contains: filter.username, mode: 'insensitive' } }),
    };
    const [rows, total] = await Promise.all([
      this.db.sysLoginLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.pageSize,
      }),
      this.db.sysLoginLog.count({ where }),
    ]);
    return toPageData(rows.map(toLoginLogItem), total);
  }

  /** §7.5.2 操作日志：resourceType/resourceId/action/username/时间范围，倒序分页。 */
  async operLogs(
    filter: OperLogFilterInput,
    page: NormalizedPageQuery,
  ): Promise<PageData<OperLogItem>> {
    const where: Prisma.SysOperLogWhereInput = {
      ...timeRangeWhere(filter),
      ...(filter.resourceType === undefined ? {} : { resourceType: filter.resourceType }),
      ...(filter.resourceId === undefined ? {} : { resourceId: filter.resourceId }),
      ...(filter.action === undefined ? {} : { action: filter.action }),
      ...(filter.username === undefined
        ? {}
        : { username: { contains: filter.username, mode: 'insensitive' } }),
    };
    const [rows, total] = await Promise.all([
      this.db.sysOperLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: page.skip,
        take: page.pageSize,
      }),
      this.db.sysOperLog.count({ where }),
    ]);
    return toPageData(rows.map(toOperLogItem), total);
  }
}

// -----------------------------------------------------------------------------
// 映射（纯函数，导出给单测直接断言）
// -----------------------------------------------------------------------------

/** 时间范围（§7.5 两接口共用）：start/end 都是可选闭区间。 */
function timeRangeWhere(
  filter: { readonly startTime?: Date | undefined; readonly endTime?: Date | undefined },
): { readonly createdAt: { readonly gte?: Date; readonly lte?: Date } } {
  const gte = filter.startTime;
  const lte = filter.endTime;
  return {
    createdAt: {
      ...(gte === undefined ? {} : { gte }),
      ...(lte === undefined ? {} : { lte }),
    },
  };
}

/** loginType 有 DB CHECK 约束；万一读到字典外的历史值，归到 login 而不是让接口 500。 */
export function toLoginLogType(value: string): LoginLogType {
  return (LOGIN_LOG_TYPES as readonly string[]).includes(value)
    ? (value as LoginLogType)
    : 'login';
}

export function toLoginLogItem(row: LoginLogRow): LoginLogItem {
  return {
    id: row.id.toString(),
    userId: row.userId === null ? null : row.userId.toString(),
    username: row.username,
    loginType: toLoginLogType(row.loginType),
    success: row.success,
    failReason: row.failReason,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

/** detail 只可能是 JSON 对象才符合对外契约；数组/标量的脏数据按"无结构化差异"处理为 null。 */
export function toDetailRecord(value: Prisma.JsonValue): null | Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function toOperLogItem(row: OperLogRow): OperLogItem {
  return {
    id: row.id.toString(),
    userId: row.userId === null ? null : row.userId.toString(),
    username: row.username,
    module: row.module,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceName: row.resourceName,
    method: row.method,
    path: row.path,
    detail: toDetailRecord(row.detail),
    ip: row.ip,
    success: row.success,
    errorMessage: row.errorMessage,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * `proto_access_log` 的写入层（数据库设计 §4.2.7；迭代实施计划 M4-T9）。
 *
 * 这里只做一件事：把缓冲里的一批行一次 `createMany` 插进去。不查、不聚合、不判口径——
 * 读侧在 `access-log.query.*`（M4-T10），口径在 `record-policy.ts`。
 *
 * 三个 NOT NULL 列的形状约束（`route_key` 140 / `path` 500 / `result` 20）由**调用方**
 * （recorder）裁剪好再传进来：这一层收到超长串就是编程错误，让数据库报错比静默截断更容易被发现。
 */
export interface AccessLogRow {
  readonly browser: null | string;
  /** 请求发生的时间，不是落库时间——批量写最多滞后 2 秒，用落库时间会把访问挪到下一个统计日。 */
  readonly createdAt: Date;
  readonly device: null | string;
  readonly ip: null | string;
  readonly isBot: boolean;
  readonly os: null | string;
  readonly path: string;
  readonly prototypeId: bigint | null;
  readonly referer: null | string;
  readonly releaseId: bigint | null;
  readonly result: string;
  readonly routeKey: string;
  readonly ua: null | string;
  readonly userId: bigint | null;
}

function toCreateInput(row: AccessLogRow): Prisma.ProtoAccessLogCreateManyInput {
  return {
    browser: row.browser,
    createdAt: row.createdAt,
    device: row.device,
    ip: row.ip,
    isBot: row.isBot,
    os: row.os,
    path: row.path,
    prototypeId: row.prototypeId,
    referer: row.referer,
    releaseId: row.releaseId,
    result: row.result,
    routeKey: row.routeKey,
    ua: row.ua,
    userId: row.userId,
  };
}

@Injectable()
export class AccessLogRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /** 一批插入；返回实际影响行数，供缓冲层在日志里写出"这次掉了多少条"。 */
  async insertMany(rows: readonly AccessLogRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const { count } = await this.db.protoAccessLog.createMany({
      data: rows.map(toCreateInput),
    });
    return count;
  }
}

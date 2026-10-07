import type { PrismaClient } from '@prisma/client';
import { VISITS_WINDOW_DAYS } from '../config/constants';

/**
 * 「近 N 天访问量」这一列的唯一实现（计划 §3.7：两处以上用到的能力收敛成一个通用件）。
 *
 * M2 时它有两份逐字相同的私有副本（`project.repo.ts` 与 `prototype.repo.ts` 各一个
 * `sevenDaysAgo()` + 一条 `protoAccessLog.groupBy`），M5-T1 的工作台要第三份。三份的意思
 * 是"三处可能漂移"，而这一列恰好是项目列表、原型列表、工作台三处都要跟用户对上的数
 * （计划 M5-T1 的判据就是「数据与项目列表能对上」），所以收敛到这里。
 *
 * 口径（`VISITS_WINDOW_DAYS` + 机制 §6）：窗口是**滚动 7×24h**，计数只算入口访问
 * （`result='ok'`，非入口的资源请求根本不写 ok 日志）。
 * 与访问记录页 §6.2 那条**日历日**窗口是两把不同的尺子，差异与理由见计划 §9.2 DEV-38。
 */
export function visitsWindowStart(now: Date = new Date()): Date {
  return new Date(now.getTime() - VISITS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

type AccessLogAccess = Pick<PrismaClient, 'protoAccessLog'>;

/**
 * 按原型取近 N 天入口访问量：一次 `groupBy` 拿全批，键是原型的字符串 id。
 *
 * `prototypeId` 在日志表上可空（编码不存在时写的那条只有 `route_key`），所以 `null` 桶要丢掉；
 * 空入参提前返回，因为 `in ()` 发到 Postgres 是语法错误而不是"查不到"。
 */
export async function entryVisitsByPrototype(
  db: AccessLogAccess,
  prototypeIds: readonly bigint[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  if (prototypeIds.length === 0) {
    return new Map<string, number>();
  }
  const rows = await db.protoAccessLog.groupBy({
    _count: { _all: true },
    by: ['prototypeId'],
    where: {
      createdAt: { gte: visitsWindowStart(now) },
      prototypeId: { in: [...prototypeIds] },
      result: 'ok',
    },
  });
  return new Map(
    rows
      .filter((row) => row.prototypeId !== null)
      .map((row) => [String(row.prototypeId), row._count._all]),
  );
}

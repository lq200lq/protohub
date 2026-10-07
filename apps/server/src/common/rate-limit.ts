import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from './exception/business.exception';

/**
 * "失败次数过多"类响应的唯一写法（后端接口设计 §2.1 与 §9.2 两处限速共用）。
 *
 * 收敛成一处的理由不是"少二十个字符"，而是这句话里藏着一个易漂的换算：剩余时间要**向上取整到分钟**
 * 且**至少 1 分钟**。向下取整会在锁还剩 30 秒时告诉用户"0 分钟后再试"，等于让他立刻重试、
 * 立刻再吃一个 429；取 0 还会让文案变成"请 0 分钟后再试"这种没人写的话。
 */

/** 向上取整到分钟，最短 1 分钟（`lockedUntil` 与 `now` 都是毫秒时间戳）。 */
export function minutesLeft(lockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((lockedUntil - now) / 60_000));
}

/** 429 + `RATE_LIMITED`，文案带剩余分钟数；调用方只需交出锁的到期时间。 */
export function rateLimitedError(
  lockedUntil: number,
  now: number = Date.now(),
): BusinessException {
  return new BusinessException(
    `失败次数过多，请 ${minutesLeft(lockedUntil, now)} 分钟后再试`,
    ERROR_CODES.RATE_LIMITED,
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

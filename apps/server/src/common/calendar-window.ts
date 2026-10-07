/**
 * 本地日历窗口的唯一起算处（后端接口设计 §6.2 的"最近 N 个日历日"、§3.1 的"本周"）。
 *
 * 为什么要单独一个文件：这类算术在两处出现（访问记录汇总的窗口、工作台统计卡的今日/本周），
 * 而写错的形态是"静默差一天"——图上少一根柱子、卡片少算一天，都不会报错（§3.7 禁止同能力两份实现）。
 *
 * 统一用 `Date` 构造器的"日"字段做位移，而不是加减 `86400000` 毫秒：跨夏令时/时区调整那天
 * 真的不是 24 小时，按毫秒算会让窗口边界漂移到前一天的某个时刻。
 */

/**
 * 相对"今天 00:00"偏移 `offset` 个日历日的那天 00:00（可为负）。
 *
 * 结果落在本地时区的那天子夜，与传入的 `now` 的时分秒无关。
 */
export function localDayStart(offset: number, now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
}

/** 今天 00:00（本地）。 */
export function localTodayStart(now: Date = new Date()): Date {
  return localDayStart(0, now);
}

/**
 * 本周起始日 00:00（本地）：周一为一周的第一天。
 *
 * `getDay()` 把周日记作 0，所以偏移是 `(getDay() + 6) % 7` 而不是 `getDay() - 1`——
 * 后者在周日会算出 `-1`，把"本周"变成"下周"。
 */
export function localWeekStart(now: Date = new Date()): Date {
  return localDayStart(-((now.getDay() + 6) % 7), now);
}

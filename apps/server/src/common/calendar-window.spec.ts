import { describe, expect, it } from 'vitest';

import { localDayStart, localTodayStart, localWeekStart } from './calendar-window';

/**
 * 本地日历窗口（计划 M5-T1 的窗口口径；接口设计 §3.1「本周/今天」、§6.2「最近 N 个日历日」）。
 * 全部用本地分量构造 `Date`（不写 `Z`），断言也用本地分量——用例的结论不能取决于跑测试的时区。
 */

describe('localDayStart', () => {
  it('偏移 0 就是把时分秒与毫秒抹平到当天 00:00', () => {
    expect(localDayStart(0, new Date(2026, 9, 7, 13, 24, 5, 900))).toEqual(new Date(2026, 9, 7));
  });

  it('负偏移跨月：按"日"字段减，而不是减毫秒数', () => {
    expect(localDayStart(-13, new Date(2026, 9, 7, 23, 59))).toEqual(new Date(2026, 8, 24));
    expect(localDayStart(25, new Date(2026, 9, 7))).toEqual(new Date(2026, 10, 1));
  });

  it('跨年也一样落在整天的零点（1 月往前推 1 天是去年 12 月 31 日）', () => {
    expect(localDayStart(-1, new Date(2027, 0, 1, 0, 0, 0, 1))).toEqual(new Date(2026, 11, 31));
  });
});

describe('localTodayStart', () => {
  it('等于 localDayStart(0)', () => {
    const now = new Date(2026, 9, 7, 18, 30);
    expect(localTodayStart(now)).toEqual(localDayStart(0, now));
  });
});

describe('localWeekStart', () => {
  it('周三回到本周一', () => {
    expect(localWeekStart(new Date(2026, 9, 7, 9, 0))).toEqual(new Date(2026, 9, 5));
  });

  it('周一就是自己（零点，不含"今天已经过的那 9 小时"）', () => {
    expect(localWeekStart(new Date(2026, 9, 5, 9, 0))).toEqual(new Date(2026, 9, 5));
  });

  it('周日算本周一的前 6 天，而不是把下周的周一当"本周起点"', () => {
    // `getDay()` 周日是 0：写成 `getDay() - 1` 会得到 -1，也就是往"后"一天 → 本周变成下周。
    expect(localWeekStart(new Date(2026, 9, 11, 22, 0))).toEqual(new Date(2026, 9, 5));
  });

  it('周日落在跨年那周时回到同一周的周一', () => {
    // 2027-01-03 是周日，它所在的周一是 2026-12-28（上周）。
    expect(localWeekStart(new Date(2027, 0, 3))).toEqual(new Date(2026, 11, 28));
  });
});

import type { DashboardOverview } from '@protohub/shared';

import dayjs from 'dayjs';

import { describe, expect, it } from 'vitest';

import {
  relativeTimeOf,
  signedPercent,
  visitDeltaOf,
  workspaceStatCards,
} from './workspace-view';

/**
 * 工作台四张统计卡的取数断言（前端设计 §3.1）：卡上的数字必须与 overview 的字段
 * 一一对应（项目数/原型数取 total、发布次数取 thisWeek、访问量取 last7d），前端不加不减。
 * 环比的两条判据（有基准出百分比、0 基准不出百分比）也钉在这里（计划 §9.2 DEV-38）。
 */

function overviewPatch(patch: Partial<DashboardOverview> = {}): DashboardOverview {
  return {
    projectStats: { archived: 1, draft: 3, published: 2, total: 6 },
    prototypeStats: { archived: 2, draft: 8, published: 4, total: 14 },
    recentEvents: [],
    recentPrototypes: [],
    releaseStats: { thisWeek: 15, today: 11 },
    visitStats: {
      deniedLast7d: 14,
      last7d: 21,
      previous7d: 0,
      today: 21,
      uvLast7d: 4,
    },
    ...patch,
  };
}

describe('workspaceStatCards', () => {
  it('四张卡各取哪个字段：项目/原型取 total，发布取 thisWeek，访问取 last7d', () => {
    const cards = workspaceStatCards(overviewPatch());
    expect(cards.map((card) => [card.key, card.value])).toEqual([
      ['projects', 6],
      ['prototypes', 14],
      ['releases', 15],
      ['visits', 21],
    ]);
    // 数字不能从别的字段抄：total 与 published/draft/archived 有意不同
    expect(cards[0]?.value).not.toBe(2);
    expect(cards[1]?.value).not.toBe(4);
    // 本周发布次数问的是新版本（DEV-38 ④），不是"今天"
    expect(cards[2]?.value).not.toBe(11);
  });

  it('只有「近 7 天访问量」带环比，其余三张不带', () => {
    const cards = workspaceStatCards(overviewPatch());
    expect(
      cards.filter((card) => card.delta !== null).map((card) => card.key),
    ).toEqual(['visits']);
    expect(cards[3]?.delta?.previous7d).toBe(0);
  });

  it('还没取到数时也给四张卡的骨架，值是 null 而不是 0（0 是"查过了没有"）', () => {
    const cards = workspaceStatCards(null);
    expect(cards.map((card) => card.key)).toEqual([
      'projects',
      'prototypes',
      'releases',
      'visits',
    ]);
    expect(cards.map((card) => card.value)).toEqual([null, null, null, null]);
    expect(cards[3]?.delta).toBeNull();
  });
});

describe('visitDeltaOf', () => {
  it('previous7d > 0 时给百分比，四舍五入到整数', () => {
    expect(visitDeltaOf({ last7d: 21, previous7d: 15 }).percent).toBe(40);
    expect(visitDeltaOf({ last7d: 10, previous7d: 20 }).percent).toBe(-50);
    expect(visitDeltaOf({ last7d: 20, previous7d: 20 }).percent).toBe(0);
    expect(visitDeltaOf({ last7d: 16, previous7d: 15 }).percent).toBe(7);
  });

  it('previous7d = 0 时不给百分比（0 基准没有可比性，不是 100%）', () => {
    const delta = visitDeltaOf({ last7d: 21, previous7d: 0 });
    expect(delta.percent).toBeNull();
    expect(delta.previous7d).toBe(0);
    expect(visitDeltaOf({ last7d: 0, previous7d: 0 }).percent).toBeNull();
  });
});

describe('signedPercent', () => {
  it('正数带 +，负数与 0 原样', () => {
    expect(signedPercent(40)).toBe('+40%');
    expect(signedPercent(-50)).toBe('-50%');
    expect(signedPercent(0)).toBe('0%');
  });
});

describe('relativeTimeOf', () => {
  it('按 now 的差值出相对时间（注入 now 以便断言）', () => {
    // fromNow 的文案跟着 dayjs 全局 locale 走，这里钉死 en 才有确定字符串
    dayjs.locale('en');
    const now = '2026-10-07T12:00:00+08:00';
    expect(relativeTimeOf('2026-10-07T09:00:00+08:00', now)).toBe('3 hours ago');
    expect(relativeTimeOf('2026-10-05T12:00:00+08:00', now)).toBe('2 days ago');
  });
});

import type { AccessLogSummary } from '@protohub/shared';

import { createApp } from 'vue';

import { describe, expect, it } from 'vitest';

import AccessLogMetricCards from './AccessLogMetricCards.vue';

/**
 * 概览 5 指标卡的取数断言（前端设计 §3.7）：卡上的数字必须与服务端
 * GET /api/access-logs/summary 的字段一一对应（PV/UV/denied/botPv/invalidPv），
 * 前端不做任何加减或再解释。挂载方式同 AccessLogPrototypeCell.spec.ts 的说明。
 */

function summaryPatch(patch: Partial<AccessLogSummary> = {}): AccessLogSummary {
  return {
    botPv: 41,
    daily: [{ date: '2026-10-07', pv: 152, uv: 31 }],
    denied: 26,
    invalidPv: 7,
    pv: 903,
    topPrototypes: [],
    topReferers: [],
    uv: 118,
    ...patch,
  };
}

function mountCards(summary: AccessLogSummary | null): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  createApp(AccessLogMetricCards, { loading: false, summary }).mount(host);
  return host;
}

describe('AccessLogMetricCards', () => {
  it('summary 的五个字段各落一张卡，数字原样直读', () => {
    const mounted = mountCards(summaryPatch());
    const expected: [string, number][] = [
      ['pv', 903],
      ['uv', 118],
      ['denied', 26],
      ['botPv', 41],
      ['invalidPv', 7],
    ];
    expect(mounted.querySelectorAll('[data-testid="accesslog-metric-card-value"]')).toHaveLength(5);
    for (const [key, value] of expected) {
      const cell = mounted.querySelector<HTMLElement>(
        `[data-testid="accesslog-metric-${key}"]`,
      );
      expect(cell, `缺少 ${key} 卡`).not.toBeNull();
      expect(cell?.textContent?.trim()).toBe(String(value));
    }
  });

  it('invalidPv=0 也照常渲染成 0（"没有无效链接"是要看得见的结论，不是空位）', () => {
    const mounted = mountCards(summaryPatch({ invalidPv: 0 }));
    expect(
      mounted.querySelector('[data-testid="accesslog-metric-invalidPv"]')?.textContent?.trim(),
    ).toBe('0');
  });

  it('summary 还没回来（null）时不渲染半截卡', () => {
    const mounted = mountCards(null);
    expect(mounted.querySelectorAll('[data-testid="accesslog-metric-card-value"]')).toHaveLength(0);
  });
});

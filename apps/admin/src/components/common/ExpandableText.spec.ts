import { createApp } from 'vue';

import { describe, expect, it } from 'vitest';

import ExpandableText from './ExpandableText.vue';

/**
 * 详情页长文本（前端设计 §10.2「长文本」）的截断判定：超长才给展开/收起，
 * 短文本原样；"超长"按字符数判（阈值可配），不数像素。挂载方式同 AccessLogMetricCards.spec。
 */
function mountText(props: { text: null | string; threshold?: number }): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  createApp(ExpandableText, props).mount(host);
  return host;
}

describe('ExpandableText', () => {
  it('短文本原样显示，不给展开按钮', () => {
    const mounted = mountText({ text: '一句话说明' });
    expect(mounted.textContent?.trim()).toContain('一句话说明');
    expect(mounted.querySelector('button')).toBeNull();
  });

  it('超过阈值才截断并给按钮', () => {
    const mounted = mountText({ text: 'a'.repeat(30), threshold: 10 });
    const paragraph = mounted.querySelector('p');
    expect(paragraph?.textContent?.trim()).toBe('a'.repeat(10) + '…');
    expect(mounted.querySelector('button')?.textContent?.trim()).toBeTruthy();
  });

  it('点按钮在"截断 / 全文"之间切换', async () => {
    const mounted = mountText({ text: 'b'.repeat(30), threshold: 10 });
    const button = mounted.querySelector('button');
    await button?.click();
    expect(mounted.querySelector('p')?.textContent?.trim()).toBe('b'.repeat(30));
    await mounted.querySelector('button')?.click();
    expect(mounted.querySelector('p')?.textContent?.trim()).toBe('b'.repeat(10) + '…');
  });

  it('null / 空串落"—"占位，不渲染空行', () => {
    expect(mountText({ text: null }).querySelector('p')?.textContent?.trim()).toBe('—');
    expect(mountText({ text: '' }).querySelector('p')?.textContent?.trim()).toBe('—');
  });
});

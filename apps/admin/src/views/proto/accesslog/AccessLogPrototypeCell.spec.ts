import type { AccessLogItem } from '@protohub/shared';

import { createApp } from 'vue';

import { describe, expect, it } from 'vitest';

import AccessLogPrototypeCell from './AccessLogPrototypeCell.vue';

/**
 * 明细表「原型」单元格的渲染断言（迭代实施计划 M4-T11 判据本体）：
 * `prototypeName` 为空且有 `routeKey` 时，必须渲染成**灰色**「无效链接」+ `routeKey` 副标题。
 * 组织方式沿用 apps/admin/src 既有 spec（就近 colocated、断言行为不断快照）；
 * 挂载用 Vue 自带 createApp（admin 未声明 @vue/test-utils，禁新增依赖）。
 *
 * i18n 文案在测试环境未安装（setupI18n 要挂 App），$t 会回退成键名——所以这里断言的是
 * "降级结构 + 灰色 token 类 + routeKey 原文"；「无效链接」四个字的实际显示在浏览器实测核对。
 */

function mountCell(row: AccessLogItem): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(AccessLogPrototypeCell, { row });
  app.mount(host);
  return host;
}

function itemPatch(patch: Partial<AccessLogItem>): AccessLogItem {
  return {
    browser: 'Chrome 141',
    createdAt: '2026-10-07T10:00:00.000Z',
    device: 'desktop',
    id: '6',
    ip: '127.0.0.x',
    isBot: false,
    os: null,
    path: '/p/nope/nope-p01/',
    projectId: null,
    projectName: null,
    prototypeCode: null,
    prototypeId: null,
    prototypeName: null,
    referer: null,
    result: 'not_found',
    routeKey: 'nope/nope-p01',
    userId: null,
    versionNo: null,
    visitorName: null,
    ...patch,
  };
}

describe('AccessLogPrototypeCell', () => {
  it('原型名存在：正常显示名字，不进降级分支', () => {
    const mounted = mountCell(itemPatch({ prototypeName: '登录页演示' }));
    expect(mounted.querySelector('[data-testid="accesslog-invalid-cell"]')).toBeNull();
    expect(mounted.textContent).toContain('登录页演示');
    expect(mounted.textContent).not.toContain('proto.accesslog.invalidLink');
  });

  it('原型名为空 + 有 routeKey（库里 id=6 的形状）→ 灰色「无效链接」+ routeKey 副标题', () => {
    const mounted = mountCell(itemPatch({ prototypeName: null }));
    const invalid = mounted.querySelector('[data-testid="accesslog-invalid-cell"]');
    expect(invalid).not.toBeNull();

    // 灰色：vben 的次级文本 token 挂在该 span 上
    const label = invalid?.querySelector('span');
    expect(label?.classList.contains('text-muted-foreground')).toBe(true);

    // 副标题是 routeKey 原文，等宽小字
    const subtitle = mounted.querySelector<HTMLElement>(
      '[data-testid="accesslog-invalid-route-key"]',
    );
    expect(subtitle?.textContent?.trim()).toBe('nope/nope-p01');
    expect(subtitle?.classList.contains('font-mono')).toBe(true);
  });

  it('名字与 routeKey 都取不到：不编造无效链接，落折行占位', () => {
    const mounted = mountCell(itemPatch({ prototypeName: null, routeKey: '' }));
    expect(mounted.querySelector('[data-testid="accesslog-invalid-cell"]')).toBeNull();
    expect(mounted.textContent?.trim()).toBe('—');
  });
});

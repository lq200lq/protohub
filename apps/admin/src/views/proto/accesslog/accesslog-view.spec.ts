import type {
  AccessLogDailyPoint,
  AccessLogItem,
  AccessLogSummary,
} from '@protohub/shared';

import { describe, expect, it } from 'vitest';

import {
  accessLogEnvSubText,
  accessLogScopeEquals,
  buildAccessLogJumpQuery,
  buildListQuery,
  buildSummaryQuery,
  buildTrendOption,
  initialScopeFromQuery,
  isVisitsMetricClickable,
  prototypeCellOf,
  resolveSummaryDays,
  resolveTimeWindow,
  resultTagOf,
  summaryMetricCards,
  toAccessLogPanelRows,
} from './accesslog-view';

/**
 * 访问记录页呈现判定的回归测试（迭代实施计划 M4-T11 判据所在的一层）。
 * 组织方式沿用 apps/admin/src 既有 spec（如 utils/publish-action.spec.ts）：对纯函数断言行为。
 * 组件里的模板只消费这里的结论；「无效链接」一行的 DOM 断言在 AccessLogPrototypeCell.spec.ts。
 */

/** 固定"现在"：2026-10-07 12:00 本地时间，窗口换算全部对着它断言，不跟时钟漂 */
const NOW = new Date(2026, 9, 7, 12, 0, 0);

function itemPatch(patch: Partial<AccessLogItem>): AccessLogItem {
  return {
    browser: 'Chrome 141',
    createdAt: '2026-10-07T10:00:00.000Z',
    device: 'desktop',
    id: '1',
    ip: '10.0.0.x',
    isBot: false,
    os: 'macOS 15',
    path: '/p/crm/crm-p01/',
    projectId: '9',
    projectName: 'CRM系统',
    prototypeCode: 'crm-p01',
    prototypeId: '31',
    prototypeName: '登录页演示',
    referer: null,
    result: 'ok',
    routeKey: 'crm/crm-p01',
    userId: null,
    versionNo: 3,
    visitorName: null,
    ...patch,
  };
}

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

describe('prototypeCellOf：「无效链接」降级（M4-T11 判据）', () => {
  it('原型名还在 → 正常行，不降级、无副标题', () => {
    expect(prototypeCellOf(itemPatch({}))).toEqual({
      invalid: false,
      routeKey: null,
      title: '登录页演示',
    });
  });

  it('prototypeName 为空且有 routeKey → 无效链接 + routeKey 作副标题', () => {
    // 库里 id=6 的形状：/p/nope/nope-p01/ 编码不存在，三个名字字段都是 null，只剩 routeKey
    const cell = prototypeCellOf(
      itemPatch({
        projectId: null,
        projectName: null,
        prototypeCode: null,
        prototypeId: null,
        prototypeName: null,
        routeKey: 'nope/nope-p01',
      }),
    );
    expect(cell.invalid).toBe(true);
    expect(cell.title).toBeNull();
    expect(cell.routeKey).toBe('nope/nope-p01');
  });

  it('空字符串的原型名同样按无效链接处理（不是显示一个空白单元格）', () => {
    const cell = prototypeCellOf(itemPatch({ prototypeName: '' }));
    expect(cell.invalid).toBe(true);
    expect(cell.routeKey).toBe('crm/crm-p01');
  });

  it('routeKey 也为空串时不编造副标题', () => {
    const cell = prototypeCellOf(itemPatch({ prototypeName: null, routeKey: '' }));
    expect(cell).toEqual({ invalid: false, routeKey: null, title: null });
  });
});

describe('summaryMetricCards：5 个指标卡的取数', () => {
  it('五个指标固定 PV/UV/被拒/爬虫/无效链接，值直读 summary 同名字段', () => {
    const cards = summaryMetricCards(summaryPatch());
    expect(cards.map((card) => card.key)).toEqual([
      'pv',
      'uv',
      'denied',
      'botPv',
      'invalidPv',
    ]);
    expect(cards.map((card) => card.value)).toEqual([903, 118, 26, 41, 7]);
  });

  it('每张卡各指一条服务端口径文案（labelKey），前端不拼解释', () => {
    for (const card of summaryMetricCards(summaryPatch())) {
      expect(card.labelKey).toBe(`proto.accesslog.metrics.${card.key}`);
    }
  });

  it('字段换了值就换了：卡与 summary 之间没有任何加工', () => {
    const cards = summaryMetricCards(summaryPatch({ invalidPv: 0, pv: 1 }));
    expect(cards[0]?.value).toBe(1);
    expect(cards[4]?.value).toBe(0);
  });
});

describe('buildListQuery：明细参数装配', () => {
  it('永远不带 maskIp——缺省即服务端默认打码最后一段（§6.1）', () => {
    const query = buildListQuery({}, { pageNumber: 1, pageSize: 20 });
    expect('maskIp' in query).toBe(false);
    expect(query).not.toHaveProperty('maskIp');
  });

  it('筛选快照原样透传，空白 keyword 归一成 undefined（不发空串给服务端）', () => {
    const query = buildListQuery(
      {
        endTime: '2026-10-07T15:59:59.999Z',
        keyword: '   ',
        projectId: '9',
        prototypeId: '31',
        result: 'not_found',
        startTime: '2026-10-01T16:00:00.000Z',
      },
      { pageNumber: 3, pageSize: 20 },
    );
    expect(query.keyword).toBeUndefined();
    expect(query.projectId).toBe('9');
    expect(query.prototypeId).toBe('31');
    expect(query.result).toBe('not_found');
    expect(query.page).toBe(3);
  });

  it('关键字非空时按 §6.1 的 keyword（IP/UA 模糊）透传', () => {
    const query = buildListQuery({ keyword: '10.0.0' }, { pageNumber: 1, pageSize: 20 });
    expect(query.keyword).toBe('10.0.0');
  });
});

describe('时间快捷 → 窗口与 days', () => {
  it('今天/近7天/近30天：列表窗口取本地日始/日终，近 7 天含今天共 7 个日历日', () => {
    const today = resolveTimeWindow('today', null, NOW);
    expect(new Date(today.startTime ?? '').getTime()).toBe(
      new Date(2026, 9, 7, 0, 0, 0, 0).getTime(),
    );
    expect(new Date(today.endTime ?? '').getTime()).toBe(
      new Date(2026, 9, 7, 23, 59, 59, 999).getTime(),
    );
    const week = resolveTimeWindow('week', null, NOW);
    expect(new Date(week.startTime ?? '').getTime()).toBe(
      new Date(2026, 9, 1, 0, 0, 0, 0).getTime(),
    );
    const month = resolveTimeWindow('month', null, NOW);
    // 近 30 天含今天 = 起点是 29 天前：2026-10-07 → 2026-09-08
    expect(new Date(month.startTime ?? '').getTime()).toBe(
      new Date(2026, 8, 8, 0, 0, 0, 0).getTime(),
    );
  });

  it('自定义：没选区间就不加时间条件；选了则夹到整日', () => {
    expect(resolveTimeWindow('custom', null, NOW)).toEqual({});
    const custom = resolveTimeWindow(
      'custom',
      [new Date(2026, 9, 2, 9, 30), new Date(2026, 9, 5, 18, 0)],
      NOW,
    );
    expect(new Date(custom.startTime ?? '').getTime()).toBe(
      new Date(2026, 9, 2, 0, 0, 0, 0).getTime(),
    );
    expect(new Date(custom.endTime ?? '').getTime()).toBe(
      new Date(2026, 9, 5, 23, 59, 59, 999).getTime(),
    );
  });

  it('summary 的 days 与列表窗口下界对齐（今天=1、近7天=7、近30天=30）', () => {
    expect(resolveSummaryDays(resolveTimeWindow('today', null, NOW), NOW)).toBe(1);
    expect(resolveSummaryDays(resolveTimeWindow('week', null, NOW), NOW)).toBe(7);
    expect(resolveSummaryDays(resolveTimeWindow('month', null, NOW), NOW)).toBe(30);
  });

  it('没筛时间就不传 days，让服务端默认 7（前端不替它决定）', () => {
    expect(resolveSummaryDays(resolveTimeWindow('custom', null, NOW), NOW)).toBeUndefined();
    expect(buildSummaryQuery({}, NOW).days).toBeUndefined();
  });

  it('窗口早于 90 天时夹到 90（后端 resolveSummaryDays 的同一条夹取，两处一个数）', () => {
    const longAgo = new Date(2026, 0, 1).toISOString();
    expect(resolveSummaryDays({ startTime: longAgo }, NOW)).toBe(90);
  });

  it('summary 与列表读同一份筛选快照（三个区块同口径的根）', () => {
    const applied = {
      endTime: '2026-10-07T15:59:59.999Z',
      projectId: '9',
      prototypeId: '31',
      result: 'ok' as const,
      startTime: '2026-10-01T16:00:00.000Z',
    };
    const summaryQuery = buildSummaryQuery(applied, NOW);
    const listQuery = buildListQuery(applied, { pageNumber: 1, pageSize: 20 });
    expect(summaryQuery.projectId).toEqual(listQuery.projectId);
    expect(summaryQuery.prototypeId).toEqual(listQuery.prototypeId);
    expect(summaryQuery.days).toBe(resolveSummaryDays(applied, NOW));
    expect(listQuery.result).toBe('ok');
  });
});

describe('initialScopeFromQuery：URL 带参进入（M4-T12 的衔接点）', () => {
  it('认 projectId / prototypeId（参数名与 access-log.query.controller.ts 一致）', () => {
    expect(
      initialScopeFromQuery({ projectId: '9', prototypeId: '31' }),
    ).toEqual({ projectId: '9', prototypeId: '31' });
  });

  it('空串、数组、非字符串一律忽略——脏参数不该变成筛选', () => {
    expect(initialScopeFromQuery({ projectId: '', prototypeId: '  ' })).toEqual({});
    expect(initialScopeFromQuery({ projectId: ['1', '2'] })).toEqual({});
    expect(initialScopeFromQuery({ page: '2' })).toEqual({});
  });
});

describe('resultTagOf：四种结果的 Tag 语义', () => {
  it('ok=绿、401/403=警示系且互不混、not_found=红', () => {
    const ok = resultTagOf('ok');
    const denied401 = resultTagOf('denied_401');
    const denied403 = resultTagOf('denied_403');
    const notFound = resultTagOf('not_found');
    expect(ok.color).toBe('green');
    expect(notFound.color).toBe('red');
    expect(denied401.color).not.toBe(denied403.color);
    expect([denied401.color, denied403.color]).not.toContain('green');
    expect([denied401.color, denied403.color]).not.toContain('red');
  });

  it('标签文案按 result 收在 proto.accesslog.results.* 一处', () => {
    expect(resultTagOf('denied_401').labelKey).toBe('proto.accesslog.results.denied_401');
  });
});

describe('buildTrendOption：PV/UV 双折线', () => {
  it('x 轴用服务端补好零值日的日历标签，两条折线各拿 pv/uv', () => {
    const daily: AccessLogDailyPoint[] = [
      { date: '2026-10-05', pv: 0, uv: 0 },
      { date: '2026-10-06', pv: 152, uv: 31 },
      { date: '2026-10-07', pv: 7, uv: 5 },
    ];
    const option = buildTrendOption(daily, { pv: 'PV', uv: 'UV' });
    expect(option.series).toHaveLength(2);
    const [pvSeries, uvSeries] = option.series as {
      data: number[];
      name: string;
    }[];
    expect(pvSeries?.name).toBe('PV');
    expect(pvSeries?.data).toEqual([0, 152, 7]);
    expect(uvSeries?.data).toEqual([0, 31, 5]);
    expect((option.xAxis as { data: string[] }).data).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
  });

  it('图例钉在顶部居中：默认 bottom 会压在 x 轴日期上，grid.top=40 是给它留的位', () => {
    const option = buildTrendOption([], { pv: 'PV', uv: 'UV' });
    expect(option.legend).toMatchObject({ left: 'center', top: 0 });
    expect((option.grid as { top: number }).top).toBeGreaterThanOrEqual(24);
  });
});

describe('buildAccessLogJumpQuery / ACCESS_LOG 跳转（M4-T12 详情页带范围跳入）', () => {
  it('发 initialScopeFromQuery 认得的那两个键，不多发', () => {
    expect(buildAccessLogJumpQuery({ projectId: '9', prototypeId: '31' })).toEqual({
      projectId: '9',
      prototypeId: '31',
    });
    expect(buildAccessLogJumpQuery({ prototypeId: '31' })).toEqual({ prototypeId: '31' });
    expect(buildAccessLogJumpQuery({ projectId: '9' })).toEqual({ projectId: '9' });
  });

  it('空范围发空 query；纯空白 id 被丢掉（不是把一个空字符串当筛选带过去）', () => {
    expect(buildAccessLogJumpQuery({})).toEqual({});
    expect(buildAccessLogJumpQuery({ projectId: '  ', prototypeId: '' })).toEqual({});
  });

  it('跳转参数与解析器同形：build 出来的 query 原样喂 initialScopeFromQuery 取回同一范围', () => {
    const scope = { projectId: '9', prototypeId: '31' };
    expect(initialScopeFromQuery(buildAccessLogJumpQuery(scope))).toEqual(scope);
  });
});

describe('accessLogScopeEquals：route.query 变化时的重筛闸门（M4-T12 同页二次跳转）', () => {
  it('两个空范围等价；undefined 与"缺这个键"等价', () => {
    expect(accessLogScopeEquals({}, {})).toBe(true);
    expect(accessLogScopeEquals({ projectId: undefined }, {})).toBe(true);
  });

  it('同 id 等价、换 id 不等价', () => {
    expect(accessLogScopeEquals({ projectId: '9' }, { projectId: '9' })).toBe(true);
    expect(accessLogScopeEquals({ projectId: '9' }, { projectId: '10' })).toBe(false);
    expect(accessLogScopeEquals({ prototypeId: '31' }, { prototypeId: '31' })).toBe(true);
  });

  it('一侧多出一个范围就不等价——否则从项目范围跳到项目+原型范围会被当成没变而漏掉重筛', () => {
    expect(accessLogScopeEquals({ projectId: '9' }, { projectId: '9', prototypeId: '31' })).toBe(
      false,
    );
    expect(accessLogScopeEquals({}, { projectId: '9' })).toBe(false);
  });
});

describe('isVisitsMetricClickable：近 7 天访问量是否可点（M4-T12）', () => {
  it('数字（含 0）可点：0 是"这 7 天没人访问"的真实读数，不是缺值', () => {
    expect(isVisitsMetricClickable(0)).toBe(true);
    expect(isVisitsMetricClickable(5)).toBe(true);
  });

  it('null / undefined 不可点：不给一个跳到空筛选的死链', () => {
    expect(isVisitsMetricClickable(null)).toBe(false);
    expect(isVisitsMetricClickable(undefined)).toBe(false);
  });
});

describe('accessLogEnvSubText：浏览器/系统/设备次级行（明细表与折叠区共用）', () => {
  const translate = (key: string) => `[${key}]`;

  it('os · 设备档位，设备文案走注入的 translate（本模块不依赖 $t）', () => {
    expect(
      accessLogEnvSubText({ device: 'mobile', os: 'iOS 17.5.1' }, translate),
    ).toBe('iOS 17.5.1 · [proto.accesslog.devices.mobile]');
  });

  it('只有 os 或只有设备各给一行；两者都缺 → 空串（页面据此不渲染这一行）', () => {
    expect(accessLogEnvSubText({ device: null, os: 'Windows 10/11' }, translate)).toBe(
      'Windows 10/11',
    );
    expect(accessLogEnvSubText({ device: 'bot', os: null }, translate)).toBe(
      '[proto.accesslog.devices.bot]',
    );
    expect(accessLogEnvSubText({ device: null, os: null }, translate)).toBe('');
  });
});

describe('toAccessLogPanelRows：原型详情折叠区的行映射（M4-T12）', () => {
  const deps = {
    formatTime: () => '2026-10-07 18:00:00',
    translate: (key: string) => `t:${key}`,
  };

  it('复用明细表那套判定：结果 Tag、时间拆行、IP 直读、env 次级行', () => {
    const [row] = toAccessLogPanelRows([itemPatch({})], deps);
    expect(row).toEqual({
      browser: 'Chrome 141',
      envSub: 'macOS 15 · t:proto.accesslog.devices.desktop',
      id: '1',
      ip: '10.0.0.x',
      path: '/p/crm/crm-p01/',
      result: { color: 'green', labelKey: 'proto.accesslog.results.ok' },
      time: { date: '2026-10-07', time: '18:00:00' },
      visitorName: null,
    });
  });

  it('结果 Tag 与明细表同一份颜色/文案（denied_401 → 橙 + results.denied_401）', () => {
    const [row] = toAccessLogPanelRows([itemPatch({ result: 'denied_401' })], deps);
    expect(row?.result).toEqual(resultTagOf('denied_401'));
    expect(row?.result.color).toBe('orange');
  });

  it('空数组给空行（诚实空态，不塞占位行）；顺序原样保留', () => {
    expect(toAccessLogPanelRows([], deps)).toEqual([]);
    const rows = toAccessLogPanelRows(
      [itemPatch({ id: 'a' }), itemPatch({ id: 'b', result: 'not_found' })],
      deps,
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]?.result.labelKey).toBe('proto.accesslog.results.not_found');
  });

  it('缺值都原样交给页面落占位（null IP / null browser / 匿名访客）', () => {
    const [row] = toAccessLogPanelRows(
      [itemPatch({ browser: null, device: null, ip: null, os: null, visitorName: null })],
      deps,
    );
    expect(row?.browser).toBeNull();
    expect(row?.ip).toBeNull();
    expect(row?.envSub).toBe('');
    expect(row?.visitorName).toBeNull();
  });
});


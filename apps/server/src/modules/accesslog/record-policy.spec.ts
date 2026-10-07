import { describe, expect, it } from 'vitest';

import { ACCESS_LOG_RESULTS } from '@protohub/shared';

import { accessLogResultOf } from './record-policy';

/**
 * 记不记、记成什么（机制 §6 的记录表；迭代实施计划 M4-T9 的判据本身）。
 *
 * 这张表是三个入口（`/api/access/check`、`/api/access/gate`、Node 直出）共用的唯一口径，
 * 所以"M4-T9：访问 20 次资源不产生 20 条记录"这条验收标准真正落在这里——
 * 资源请求的 200 必须返回 `null`，其余两个入口才不可能各自把它记一遍。
 */
describe('入口文档（机制 §6 的第一行）', () => {
  it('200 记一条 ok', () => {
    expect(accessLogResultOf({ isEntry: true, status: 200 })).toBe('ok');
  });

  it('被拒时不区分入口与资源：401/403 都要记（否则"有人打不开"这件事只看得见一半）', () => {
    expect(accessLogResultOf({ isEntry: true, status: 401 })).toBe('denied_401');
    expect(accessLogResultOf({ isEntry: false, status: 401 })).toBe('denied_401');
    expect(accessLogResultOf({ isEntry: true, status: 403 })).toBe('denied_403');
    expect(accessLogResultOf({ isEntry: false, status: 403 })).toBe('denied_403');
  });
});

describe('资源请求（机制 §6：不记，否则 PV 虚高几十倍）', () => {
  it.each([301, 302, 304, 500, 502, 206] as const)('%s 一律不记', (status) => {
    expect(accessLogResultOf({ isEntry: false, status })).toBeNull();
    expect(accessLogResultOf({ isEntry: true, status })).toBeNull();
  });

  it('20 次资源 200 + 1 次入口 200 → 只有入口那条是记录', () => {
    // 这就是计划里 M4-T9 那行验收标准的纯函数形态：口径与调用次数无关，20 次都是 null
    const results = Array.from({ length: 20 }, () =>
      accessLogResultOf({ isEntry: false, status: 200 }),
    );
    results.push(accessLogResultOf({ isEntry: true, status: 200 }));

    expect(results.filter((r) => r !== null)).toEqual(['ok']);
  });
});

describe('404 是唯一两种结果共存的状态', () => {
  it('入口 404 = 链接指向的原型不存在', () => {
    expect(accessLogResultOf({ isEntry: true, status: 404 })).toBe('not_found');
  });

  it('资源 404 = 版本目录里少文件（白屏那条线索）', () => {
    expect(accessLogResultOf({ isEntry: false, status: 404 })).toBe('not_found');
  });
});

it('结果值只能是枚举里那四个（`result` 列的取值集合与 shared 对齐）', () => {
  const emitted = [
    accessLogResultOf({ isEntry: true, status: 200 }),
    accessLogResultOf({ isEntry: true, status: 401 }),
    accessLogResultOf({ isEntry: true, status: 403 }),
    accessLogResultOf({ isEntry: true, status: 404 }),
  ];

  expect(emitted.sort()).toEqual([...ACCESS_LOG_RESULTS].sort());
});

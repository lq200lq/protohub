import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { UPLOAD_WARNING_CODES, type UploadTaskWarning } from '@protohub/shared';

import { toWarnings, warningsToJson } from './warnings-codec';

/**
 * 发布告警 jsonb 读写的单测（机制 §2.7，计划 §3.6「纯函数必须有单测」）。
 *
 * 同一份告警落在两处（`proto_upload_task.warnings` 与 `proto_release.manifest.warnings`），
 * 两处都只经这两个函数进出，所以这里钉三件只有这一处负责的事：
 * 1. **读侧宽松**：认不出的 code、缺 message 的条目只丢自己那一条，不抛、不整批丢——
 *    一条坏数据不该让版本列表整页打不开（列表里的计数与报告是补充信息，§2.7 原文的取向）；
 * 2. **`count` 只在是非负整数时才带**：缺省就真的没有这个键，而不是 `null`/`undefined` 混进 jsonb，
 *    让界面分不清"没有计数"和"计数为 0"；负数同样不算计数（"改写了 -3 处"不是可展示的事实），
 *    取向与 `version.repo.ts` 的 `toCount` 一致；
 * 3. **读写互逆**：任务里说改写了 12 处，版本报告里同一条不能被判定成非法丢掉（两处口径必须一致）。
 */

/** 两条真实产出，形状取自 `postprocess.ts`：一条不带计数（脱壳）、一条带（改写）。 */
const UNWRAP: UploadTaskWarning = {
  code: UPLOAD_WARNING_CODES.UNWRAP_SINGLE_TOP_DIR,
  message: '已自动上提目录「proto2」，入口为 index.html',
};

const REWRITE: UploadTaskWarning = {
  code: UPLOAD_WARNING_CODES.REWRITE_ABSOLUTE_PATH,
  count: 12,
  message: '已将 12 处根绝对路径改写为 /p/crm/crm-p01/ 前缀（HTML 9 处，CSS 3 处）',
};

/** 库里那一列读回来的样子（jsonb 数组：任务行与 manifest.warnings 都是这个形状）。 */
const DB_REPORT: Prisma.JsonValue = [
  { code: 'UNWRAP_SINGLE_TOP_DIR', message: UNWRAP.message },
  { code: 'REWRITE_ABSOLUTE_PATH', count: 12, message: REWRITE.message },
];

describe('读侧：宽松到只丢自己那一条', () => {
  const NON_ARRAYS: readonly Prisma.JsonValue[] = [
    null,
    'REWRITE_ABSOLUTE_PATH',
    12,
    true,
    { code: 'REWRITE_ABSOLUTE_PATH', message: '被人工写成了一个对象而不是数组' },
  ];

  it.each(NON_ARRAYS)('非数组（%p）读成「没有告警」而不是抛', (value) => {
    expect(toWarnings(value)).toEqual([]);
  });

  it('坏条目逐个跳过，好条目按原顺序留下：一条坏数据不毁掉整份报告', () => {
    const value: Prisma.JsonValue = [
      { code: REWRITE.code, count: 12, message: REWRITE.message },
      null,
      '一句裸字符串',
      42,
      ['数组项也不是对象'],
      [{ code: UNWRAP.code, message: UNWRAP.message }],
      { code: 'REWRITE_ALL_PATHS', message: '认不出的 code' },
      { message: '缺 code 的条目' },
      { code: REWRITE.code, message: 12 },
      { code: UNWRAP.code, message: UNWRAP.message },
    ];

    expect(toWarnings(value)).toEqual([REWRITE, UNWRAP]);
  });

  it('六种 §2 警告码全认：取值域来自 shared 的那份清单，不是这里自己抄一遍', () => {
    const codes = Object.values(UPLOAD_WARNING_CODES);
    const value: Prisma.JsonValue = codes.map((code) => ({ code, message: `${code} 的人话` }));

    expect(toWarnings(value).map((warning) => warning.code)).toEqual([...codes]);
  });

  it('code 大小写不符也不认（库里那一列没有 CHECK，宽松不等于来者不拒）', () => {
    expect(toWarnings([{ code: 'rewrite_absolute_path', message: '小写的' }])).toEqual([]);
  });

  it('message 缺失或不是字符串 → 丢掉：界面没有正文可显示', () => {
    expect(toWarnings([{ code: UNWRAP.code }])).toEqual([]);
    expect(toWarnings([{ code: UNWRAP.code, message: null }])).toEqual([]);
  });

  it('count 只在是非负整数时带上：缺省、负数、小数、字符串、null 都不留这个键', () => {
    for (const count of [undefined, -3, 12.5, '12', null]) {
      const value: Prisma.JsonValue = [{ code: REWRITE.code, count, message: REWRITE.message }];
      const [warning] = toWarnings(value);
      expect(warning).toStrictEqual({ code: REWRITE.code, message: REWRITE.message });
      expect(Object.hasOwn(warning ?? {}, 'count'), `count=${String(count)}`).toBe(false);
    }
  });

  it('count 为 0 是合法计数（"0 处"与"没计数"是两回事，不能一起丢掉）', () => {
    expect(toWarnings([{ code: REWRITE.code, count: 0, message: REWRITE.message }])).toEqual([
      { code: REWRITE.code, count: 0, message: REWRITE.message },
    ]);
  });
});

describe('写侧：落 jsonb 的那份形状', () => {
  it('空告警写成空数组，不是 null（那一列 NOT NULL 且默认 `[]::jsonb`）', () => {
    expect(warningsToJson([])).toEqual([]);
  });

  it('原样逐条落库：计数留着、没计数的就是不写这个键', () => {
    expect(warningsToJson([UNWRAP, REWRITE])).toStrictEqual([
      { code: UNWRAP.code, message: UNWRAP.message },
      { code: REWRITE.code, count: 12, message: REWRITE.message },
    ]);
  });

  it('逐条浅拷贝：Prisma 提交前才序列化，留引用会被后续修改污染', () => {
    const warning: UploadTaskWarning = { ...REWRITE };
    const json = warningsToJson([warning]);
    warning.count = 99;

    expect(json).toStrictEqual([{ code: REWRITE.code, count: 12, message: REWRITE.message }]);
  });
});

describe('§2.7 两处落库共用一份口径', () => {
  it('读侧→写侧同一条不变：任务里的 12 处，到版本报告里还是 12 处', () => {
    expect(warningsToJson(toWarnings(DB_REPORT))).toStrictEqual(DB_REPORT);
  });

  it('写侧落库再读回是原样：同一份告警在两处读出来必然一致', () => {
    const stored = JSON.stringify(warningsToJson([UNWRAP, REWRITE]));

    expect(toWarnings(JSON.parse(stored) as Prisma.JsonValue)).toEqual([UNWRAP, REWRITE]);
  });
});

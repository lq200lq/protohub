import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  AccessLogQueryRepo,
  type AccessLogConditions,
} from './access-log.query.repo';

/**
 * 访问记录 SQL 层单测（后端接口设计 §6.1/§6.2，计划 M4-T10）。
 *
 * 钉的是四件只有看 SQL 才能判住的事：
 * 1. **输入只能进绑定参数**——SQL 文本里出现用户给的值（编码、关键字）就是失败；
 * 2. **范围条件是"可见原型 ∪ 可见项目编码"的或**，且 `dataScope=all` 时整条条件不存在；
 * 3. **空集合是恒假而不是不过滤**（漏了这条，"一个项目都看不见"会变成"全库都能看见"）；
 * 4. **§6.2 的五个口径与 UV 的 (日, ip, ua) 去重/排 bot** 写在 filter 表达式里。
 *
 * 真库不接：`lateral`、`filter (where)`、`inet::text ilike` 的语法正确性属于集成测试范围，
 * 这层只保证渲染出来的语句形状与参数位置对。
 */

function normalizeSql(arg: unknown): { readonly sql: string; readonly values: readonly unknown[] } {
  const fragment = arg as { sql?: string; values?: unknown[] };
  return { sql: fragment.sql ?? '', values: fragment.values ?? [] };
}

/** 汇总查询恒有一行（真库里 `count(*)` 不会返回空结果集），桩也必须给一行，否则测的是防御分支而不是 SQL。 */
const AGGREGATE_ROW = {
  bot_pv: 0n,
  denied: 0n,
  invalid_pv: 0n,
  pv: 0n,
  uv: 0n,
};

interface HarnessOptions {
  readonly rows?: readonly unknown[];
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    $queryRaw: vi.fn(async (fragment: unknown): Promise<unknown> => {
      const normalized = normalizeSql(fragment);
      calls.push({ sql: normalized.sql, values: [...normalized.values] });
      return options.rows ?? [AGGREGATE_ROW];
    }),
  };
  return { calls, db: db as unknown as PrismaClient };
}

function conditions(overrides: Partial<AccessLogConditions> = {}): AccessLogConditions {
  return {
    endAt: null,
    keyword: null,
    project: null,
    prototypeId: null,
    result: null,
    scope: null,
    startAt: null,
    ...overrides,
  };
}

describe('AccessLogQueryRepo 的条件渲染', () => {
  it('可见范围的两条支路都走绑定参数，SQL 文本里不出现项目编码', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(
      conditions({
        scope: { projectCodes: ['crm', 'erp'], prototypeIds: [31n, 32n] },
      }),
    );

    const call = fake.calls[0];
    expect(call?.sql).toContain('l.prototype_id in (?,?)');
    expect(call?.sql).toContain("split_part(l.route_key, '/', 1) in (?,?)");
    expect(call?.sql).not.toContain('crm');
    expect(call?.values).toEqual([31n, 32n, 'crm', 'erp']);
  });

  it('dataScope=all 的调用方（scope 为 null）根本不产生范围条件', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({ scope: null }));

    const call = fake.calls[0];
    // 指标表达式里的 `filter (where …)` 是常驻的，所以这里判的是"没有 where 子句 + 一个参数都没有"
    expect(call?.sql).not.toContain("split_part(l.route_key, '/', 1) in");
    expect(call?.values).toEqual([]);
  });

  it('范围内一个项目都没有时渲染成恒假，而不是"没有条件"（那等于放行全库）', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({ scope: { projectCodes: [], prototypeIds: [] } }));

    const call = fake.calls[0];
    expect(call?.sql).toContain('false');
    expect(call?.sql).not.toContain('in ()');
    expect(call?.values).toEqual([]);
  });

  it('projectId 筛选按"该项目下全部原型 ∪ route_key 首段等于该项目编码"求交，范围条件仍在', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(
      conditions({
        project: { code: 'crm', prototypeIds: [31n] },
        scope: { projectCodes: ['crm'], prototypeIds: [31n, 32n] },
      }),
    );

    const call = fake.calls[0];
    expect(call?.sql).toContain("split_part(l.route_key, '/', 1) = ?");
    // 范围条件在前、筛选条件在后：两支都在，交集才成立（参数顺序 = 可见原型 ∪ 可见编码 ∪ 该项目原型 ∪ 该项目编码）
    expect(call?.values).toEqual([31n, 32n, 'crm', 31n, 'crm']);
  });

  it('关键字里的 % 与 _ 被转义后才进 LIKE 模式（搜"10."不该命中全表）', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({ keyword: '10.%_' }));

    const call = fake.calls[0];
    expect(call?.sql).toContain('l.ip::text ilike ?');
    expect(call?.sql).toContain('l.ua ilike ?');
    expect(call?.values).toEqual(['%10.\\%\\_%', '%10.\\%\\_%']);
  });

  it('时间区间与 result/prototypeId 各自成一支条件（区间是闭区间，两端都含）', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-10-06T23:59:59Z');
    await repo.aggregate(conditions({ endAt: end, prototypeId: 31n, result: 'denied_403', startAt: start }));

    const call = fake.calls[0];
    expect(call?.sql).toContain('l.prototype_id = ?');
    expect(call?.sql).toContain('l.result = ?');
    expect(call?.sql).toContain('l.created_at >= ?');
    expect(call?.sql).toContain('l.created_at <= ?');
    expect(call?.values).toEqual([31n, 'denied_403', start, end]);
  });
});

describe('AccessLogQueryRepo.findPage（§6.1 明细）', () => {
  it('五个展示列都是左连接：日志行不会因为原型/版本/用户缺失而消失', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.findPage(conditions({}), { pageSize: 20, skip: 0 });

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain('left join proto_prototype p on p.id = l.prototype_id');
    expect(sql).toContain('left join proto_release r on r.id = l.release_id');
    expect(sql).toContain('left join sys_user u on u.id = l.user_id');
    expect(sql.match(/left join/g)?.length).toBe(4);
  });

  it('同一毫秒落库的多条靠 id 定次序；limit/offset 取整数值（浮点会被 Postgres 拒）', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.findPage(conditions({}), { pageSize: 20, skip: 40 });

    const call = fake.calls[0];
    expect(call?.sql).toContain('order by l.created_at desc, l.id desc');
    expect(call?.values).toEqual([20n, 40n]);
  });

  it('计数查询不背展示用的左连接，但仍带同一套范围条件', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.findPage(conditions({ scope: { projectCodes: ['crm'], prototypeIds: [31n] } }), {
      pageSize: 20,
      skip: 0,
    });

    const countCall = fake.calls[1];
    expect(countCall?.sql).toContain('count(*)::bigint as total');
    expect(countCall?.sql).not.toContain('left join');
    expect(countCall?.values).toEqual([31n, 'crm']);
  });
});

describe('AccessLogQueryRepo 的汇总口径（§6.2）', () => {
  it('pv/拒绝/bot 三个次数都按 result 分档，一次扫表算完', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({}));

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain("count(*) filter (where l.result = 'ok')::bigint as pv");
    expect(sql).toContain("count(*) filter (where l.result in ('denied_401', 'denied_403'))::bigint as denied");
    expect(sql).toContain("count(*) filter (where l.result = 'ok' and l.is_bot)::bigint as bot_pv");
  });

  /**
   * 机制 §6 的记录表有两行都写 `not_found`：一行是"编码不存在/原型已删除"（invalidPv 的数据源），
   * 一行是"活原型里的资源缺失"（白屏线索）。只按 result 数就会把后者算进「无效链接访问」卡片，
   * 于是同一屏上卡片说 10、明细表里只有一行显示「无效链接」——所以这里必须再带原型连不上的半条。
   */
  it('无效链接访问只数连不上原型的那类 not_found，判定与明细共用同一个连接', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({}));

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain('left join proto_prototype p on p.id = l.prototype_id');
    expect(sql).toContain(
      "count(*) filter (where l.result = 'not_found' and (p.id is null or p.deleted_at is not null))::bigint as invalid_pv",
    );
  });

  it('UV 是"同日 + 同 IP + 同 UA"去重，且爬虫请求不计入（机制 §6）', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.aggregate(conditions({}));

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain('count(distinct (date_trunc(\'day\', l.created_at), l.ip, l.ua))');
    expect(sql).toContain("filter (where l.result = 'ok' and not l.is_bot)::bigint as uv");
  });

  it('库返回空结果集时停下而不是猜五个 0（那会被画成"平台最近没人用"）', async () => {
    const fake = harness({ rows: [] });
    const repo = new AccessLogQueryRepo(fake.db);
    await expect(repo.aggregate(conditions({}))).rejects.toThrow('访问记录汇总未返回结果');
  });

  it('按天趋势只截到日粒度回原始 date，日历日标签留给服务层按本地时区出', async () => {

    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.daily(conditions({}));

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain('date_trunc(\'day\', l.created_at) as day');
    expect(sql).not.toContain('to_char');
    expect(sql).toContain('group by 1');
  });

  it('原型榜只统计 ok 且必须有 prototype_id，取前十', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.topPrototypes(conditions({}));

    const sql = fake.calls[0]?.sql ?? '';
    expect(sql).toContain('l.prototype_id is not null');
    expect(sql).toContain("l.result = 'ok'");
    expect(sql).toContain('limit 10');
  });

  it('来源榜按 referer 的 origin 聚合：query 与 path 不进分组，空来源不占名次', async () => {
    const fake = harness();
    const repo = new AccessLogQueryRepo(fake.db);
    await repo.topReferers(conditions({}));

    const call = fake.calls[0];
    expect(call?.sql).toContain("'^[a-z][a-z0-9+.-]*://[^/?#]+'");
    expect(call?.sql).toContain('is not null');
    expect(call?.sql).toContain('limit 10');
    // origin 的正则是 SQL 里的常量，不该以参数身份出现
    expect(call?.values).not.toContain('^[a-z][a-z0-9+.-]*://[^/?#]+');
  });
});

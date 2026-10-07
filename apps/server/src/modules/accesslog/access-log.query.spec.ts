import type { PrismaClient } from '@prisma/client';
import { ERROR_CODES, type AccessLogItem } from '@protohub/shared';
import { describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../../common/exception/business.exception';
import { localDayStart } from '../../common/calendar-window';
import { normalizePageQuery } from '../../common/pagination/pagination';
import type { PermissionCodeService } from '../../common/permission/permission-code.service';
import type { Actor } from '../system/common/actor';
import { parseWithSchema } from '../system/common/dto';
import { AccessLogQueryController } from './access-log.query.controller';
import {
  AccessLogQueryRepo,
  type AccessLogAggregateRow,
  type AccessLogDailyRow,
  type AccessLogPrototypeCountRow,
  type AccessLogRawRow,
  type AccessLogRefererCountRow,
} from './access-log.query.repo';
import {
  AccessLogQueryService,
  RAW_IP_PERMISSION,
  accessLogListQuerySchema,
  accessLogSummaryQuerySchema,
  buildSummaryWindow,
  emptyVisitStats,
  fillDaily,
  localDateKey,
  maskIpTail,
  resolveSummaryDays,
  toAccessLogDevice,
  toAccessLogItem,
  toAccessLogResult,
  toVisitStats,
  type AccessLogListFilter,
} from './access-log.query.service';

/**
 * 访问记录读接口单测（后端接口设计 §6.1/§6.2，计划 M4-T10）。
 *
 * 真库不接：`PrismaClient` 用桩，裸 SQL 只记录"渲染出的语句 + 绑了哪些值"。判的是四件只有这一层
 * 负责的事：**数据范围**（member 档不能读到别人项目的流量）、**IP 打码与其权限闸门**、
 * **降级展示**（原型/版本/项目查不到时只剩 routeKey）、**§6.2 的窗口与口径装配**。
 * SQL 自身的形状（`filter (where)`、UV 去重键、榜单 limit）在 `access-log.query.repo.spec.ts` 里钉。
 */

const MEMBER_SCOPE_WHERE = {
  OR: [{ createdBy: 7n }, { members: { some: { userId: 7n } } }],
};

const EMPTY_AGGREGATE: AccessLogAggregateRow = {
  bot_pv: 0n,
  denied: 0n,
  invalid_pv: 0n,
  pv: 0n,
  uv: 0n,
};

interface NamedPrototype {
  readonly code: string;
  readonly id: bigint;
  readonly name: string;
  readonly project: { name: string };
}

interface HarnessOptions {
  readonly aggregate?: Partial<AccessLogAggregateRow>;
  readonly daily?: readonly AccessLogDailyRow[];
  readonly listRows?: readonly AccessLogRawRow[];
  readonly namedPrototypes?: readonly NamedPrototype[];
  /** `projectId` 筛选项解析出的"该项目下的原型"（与可见原型是两次不同的查询） */
  readonly projectPrototypes?: ReadonlyArray<{ id: bigint }>;
  /** `projectId` 筛选项解析出的项目行；`null` = 库里没有这个项目 */
  readonly projectRow?: { code: string; id: bigint } | null;
  readonly referers?: readonly AccessLogRefererCountRow[];
  readonly scopeProjects?: ReadonlyArray<{ code: string }>;
  readonly scopePrototypes?: ReadonlyArray<{ id: bigint }>;
  readonly topPrototypes?: readonly AccessLogPrototypeCountRow[];
  readonly total?: bigint;
}

interface RawCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface Harness {
  readonly calls: RawCall[];
  readonly db: PrismaClient;
  /** 找到包含某段文本的那一次裸 SQL；找不到就失败，绝不让断言静默通过 */
  readonly find: (marker: string) => RawCall;
  readonly projectQueries: unknown[];
  readonly prototypeQueries: unknown[];
}

/** 明细行那一次查询独有 `as visitor_name`，取它就不用再关心其它查询的顺序。 */
function rowsCallOf(fake: Harness): RawCall {
  return fake.find('as visitor_name');
}

function normalizeSql(arg: unknown): RawCall {
  const fragment = arg as { sql?: string; values?: unknown[] };
  return { sql: fragment.sql ?? '', values: [...(fragment.values ?? [])] };
}

/** 按 SQL 里独有的输出列名分派返回值：比"第几次调用"稳，加了并行查询也不会错位。 */
function dispatch(options: HarnessOptions, sql: string): unknown {
  if (sql.includes('as visitor_name')) {
    return options.listRows ?? [];
  }
  if (sql.includes('count(*)::bigint as total')) {
    return [{ total: options.total ?? 0n }];
  }
  if (sql.includes('as invalid_pv')) {
    return [{ ...EMPTY_AGGREGATE, ...options.aggregate }];
  }
  if (sql.includes('as day')) {
    return options.daily ?? [];
  }
  if (sql.includes('group by l.prototype_id')) {
    return options.topPrototypes ?? [];
  }
  if (sql.includes('as origin')) {
    return options.referers ?? [];
  }
  throw new Error(`未预期的裸 SQL：${sql.slice(0, 120)}`);
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: RawCall[] = [];
  const projectQueries: unknown[] = [];
  const prototypeQueries: unknown[] = [];

  const db = {
    $queryRaw: vi.fn(async (fragment: unknown): Promise<unknown> => {
      const call = normalizeSql(fragment);
      calls.push(call);
      return dispatch(options, call.sql);
    }),
    protoProject: {
      findFirst: vi.fn(async (args: unknown) => {
        projectQueries.push(args);
        // 默认给一行：绝大多数筛项目的用例要的是"项目存在"，只有判 missing 的用例显式要 null
        return options.projectRow === undefined ? { code: 'crm', id: 9n } : options.projectRow;
      }),
      findMany: vi.fn(async (args: unknown) => {
        projectQueries.push(args);
        return options.scopeProjects === undefined ? [{ code: 'crm' }] : options.scopeProjects;
      }),
    },
    protoPrototype: {
      findMany: vi.fn(
        async (args: { select?: Record<string, unknown>; where?: Record<string, unknown> }) => {
          prototypeQueries.push(args);
          // 取名那次（榜单）与取 id 那两次（可见范围 / 项目下原型）靠 select 的列区分
          if (args.select && 'name' in args.select) {
            return options.namedPrototypes ?? [];
          }
          return args.where && 'projectId' in args.where
            ? (options.projectPrototypes ?? [{ id: 31n }])
            : (options.scopePrototypes ?? [{ id: 31n }, { id: 32n }]);
        },
      ),
    },
  };

  return {
    calls,
    db: db as unknown as PrismaClient,
    find: (marker: string): RawCall => {
      const call = calls.find((entry) => entry.sql.includes(marker));
      if (call === undefined) {
        throw new Error(
          `没有一次裸 SQL 带 "${marker}"：${calls.map((entry) => entry.sql.slice(0, 60)).join(' | ')}`,
        );
      }
      return call;
    },
    projectQueries,
    prototypeQueries,
  };
}

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    dataScope: 'member',
    isSuperAdmin: false,
    roles: ['viewer'],
    userId: '7',
    username: 'viewer01',
    ...overrides,
  };
}

function rawRow(overrides: Partial<AccessLogRawRow> = {}): AccessLogRawRow {
  return {
    browser: 'Chrome 141',
    created_at: new Date('2026-10-06T06:30:00.000Z'),
    device: 'desktop',
    id: 9021n,
    ip: '116.226.1.2',
    is_bot: false,
    os: 'macOS 15',
    path: '/p/crm/crm-p01/',
    project_deleted_at: null,
    project_id: 9n,
    project_name: 'CRM系统',
    prototype_code: 'crm-p01',
    prototype_deleted_at: null,
    prototype_id: 31n,
    prototype_name: '登录页演示',
    referer: 'https://chat.company.com/room/1',
    result: 'ok',
    route_key: 'crm/crm-p01',
    ua: 'Mozilla/5.0 (Macintosh) Chrome/141.0.0.0',
    user_id: null,
    version_no: 3,
    visitor_name: null,
    ...overrides,
  };
}

function listFilter(query: Record<string, unknown>): AccessLogListFilter {
  return accessLogListQuerySchema.parse(query);
}

function createService(options: HarnessOptions = {}, codes: readonly string[] = []) {
  const fake = harness(options);
  const codesOfUser = vi.fn(async (): Promise<ReadonlySet<string>> => new Set(codes));
  const service = new AccessLogQueryService(
    fake.db,
    new AccessLogQueryRepo(fake.db),
    { codesOfUser } as unknown as PermissionCodeService,
  );
  return { codesOfUser, fake, service };
}

/** 最近 n 天的本地日历日标签（含今天）：用例要的"今天/昨天"按同一把尺子算，不依赖跑测试的时区。 */
function recentKeys(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_unused, index) =>
    localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index))),
  );
}

/** 正午时分的那一天：不会被"跨零点"边界影响，专门用来造库里的日桶。 */
function noonOf(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12, 0, 0);
}

/**
 * 递归收集对象里出现的键名。
 * 可见范围条件里带 BigInt（`createdBy: 7n`），`JSON.stringify` 会直接抛错，
 * 而这里只想断言"没有第二个 deletedAt 过滤"，按键名判断就够了。
 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [
      key,
      ...keysOf(nested),
    ]);
  }
  return [];
}

// -----------------------------------------------------------------------------
// §6.1 IP 的展示口径
// -----------------------------------------------------------------------------

describe('§6.1 明细的 IP 展示', () => {
  it('默认只看到打码后的 IP，并且一次权限查询都不发', async () => {
    const { codesOfUser, service } = createService({ listRows: [rawRow()] });
    const data = await service.list(actor(), listFilter({}), normalizePageQuery({}));

    expect(data.items[0]?.ip).toBe('116.226.1.x');
    expect(codesOfUser).not.toHaveBeenCalled();
  });

  it('握着 system:log:list 的人显式要 maskIp=false 才拿到明文', async () => {
    const { service } = createService({ listRows: [rawRow()] }, [RAW_IP_PERMISSION]);
    const data = await service.list(actor(), listFilter({ maskIp: 'false' }), normalizePageQuery({}));

    expect(data.items[0]?.ip).toBe('116.226.1.2');
  });

  it('没有 system:log:list 时 maskIp=false 只是被忽略，既不报错也不给明文', async () => {
    const { service } = createService({ listRows: [rawRow()] }, ['proto:accesslog:list']);
    const data = await service.list(actor(), listFilter({ maskIp: 'false' }), normalizePageQuery({}));

    expect(data.items[0]?.ip).toBe('116.226.1.x');
  });

  it('超管不用查权限码表也能拿明文', async () => {
    const { codesOfUser, service } = createService({ listRows: [rawRow()] });
    const data = await service.list(
      actor({ isSuperAdmin: true }),
      listFilter({ maskIp: 'false' }),
      normalizePageQuery({}),
    );

    expect(data.items[0]?.ip).toBe('116.226.1.2');
    expect(codesOfUser).not.toHaveBeenCalled();
  });

  it('IPv4 只打最后一段，网段留着好判断"同一批来的人"', () => {
    expect(maskIpTail('116.226.1.2')).toBe('116.226.1.x');
    expect(maskIpTail('10.0.0.1')).toBe('10.0.0.x');
  });

  it('IPv6 打最后一组；内嵌 IPv4 的映射地址整段尾部一起削掉，不猜哪段是"最后一段"', () => {
    expect(maskIpTail('2001:db8::1')).toBe('2001:db8::xxxx');
    expect(maskIpTail('::ffff:116.226.1.2')).toBe('::ffff:xxxx');
    expect(maskIpTail(':1::2')).toBe(':1::xxxx');
  });

  it('认不出形状却带点或冒号的值只留第一段，绝不回显疑似地址', () => {
    expect(maskIpTail('116.226.1.2:8080')).toBe('116.x');
    expect(maskIpTail('10.0.0.0/8')).toBe('10.x');
    // 首字符就是分隔符：连"第一段"都没有，整值换成 x（这分支收的是代理链里混进来的脏值）
    expect(maskIpTail('.1.2.3.4')).toBe('x');
    expect(maskIpTail(':garbage:1')).toBe('x');
  });

  it('不含点也不含冒号的值不是 IP，原样返回；没有 IP 就是空', () => {
    expect(maskIpTail('localhost')).toBe('localhost');
    expect(maskIpTail('crawler-01')).toBe('crawler-01');
    expect(maskIpTail(null)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §6.1 数据范围（接口设计没写，但 publisher/viewer 都是 member 档，见权限模型 §3.5/§5 角色表）
// -----------------------------------------------------------------------------

describe('§6.1 的数据范围', () => {
  it('成员档的可见项目条件来自 projectScopeWhere，一份规则不分叉', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(actor(), listFilter({}), normalizePageQuery({}));

    expect(fake.projectQueries[0]).toEqual({ select: { code: true }, where: MEMBER_SCOPE_WHERE });
    // 原型侧同样用那一份条件（而不是"只认 created_by"的第二套规则）
    expect(fake.prototypeQueries[0]).toEqual({
      select: { id: true },
      where: { project: MEMBER_SCOPE_WHERE },
    });
  });

  it('仅本人创建档把可见范围收到"我建的项目"，软删项目不额外排除（旧链接的流量还要看得见）', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(actor({ dataScope: 'own' }), listFilter({}), normalizePageQuery({}));

    expect(fake.projectQueries[0]).toEqual({ select: { code: true }, where: { createdBy: 7n } });
    expect(keysOf(fake.projectQueries[0])).not.toContain('deletedAt');
  });

  it('可见原型与可见项目编码都绑进范围条件：只有 route_key 的行也出不了这个集合', async () => {
    const { fake, service } = createService({
      listRows: [rawRow()],
      scopeProjects: [{ code: 'crm' }, { code: 'erp' }],
      scopePrototypes: [{ id: 31n }],
    });
    await service.list(actor(), listFilter({}), normalizePageQuery({}));

    const call = rowsCallOf(fake);
    expect(call.sql).toContain('l.prototype_id in (?)');
    expect(call.sql).toContain("split_part(l.route_key, '/', 1) in (?,?)");
    expect(call.values).toContain(31n);
    expect(call.values).toContain('erp');
  });

  it('全局档不查可见项目、也不产生范围条件', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(actor({ dataScope: 'all' }), listFilter({}), normalizePageQuery({}));

    expect(fake.projectQueries).toHaveLength(0);
    const call = rowsCallOf(fake);
    expect(call.sql).not.toContain("split_part(l.route_key, '/', 1) in");
    // 只剩 limit/offset 两个参数
    expect(call.values).toEqual([20n, 0n]);
  });

  it('范围内一个项目都没有时回空页，并且一次都不扫日志表', async () => {
    const { fake, service } = createService({
      listRows: [rawRow()],
      scopeProjects: [],
      scopePrototypes: [],
    });
    const data = await service.list(actor(), listFilter({}), normalizePageQuery({}));

    expect(data).toEqual({ items: [], total: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it('按项目筛是"与范围求交"而不是"绕过范围"', async () => {
    const { fake, service } = createService({
      listRows: [rawRow()],
      projectPrototypes: [{ id: 31n }],
      projectRow: { code: 'crm', id: 9n },
      scopeProjects: [{ code: 'crm' }],
      scopePrototypes: [{ id: 31n }, { id: 32n }],
    });
    await service.list(actor(), listFilter({ projectId: '9' }), normalizePageQuery({}));

    // 范围条件在前（可见原型 31/32 + 编码 crm），筛选项在后（项目 9 下的原型 + 项目编码）
    expect(rowsCallOf(fake).values).toEqual([31n, 32n, 'crm', 31n, 'crm', 20n, 0n]);
  });

  it('筛一个库里没有的项目时回空页而不是回全量', async () => {
    const { fake, service } = createService({ listRows: [rawRow()], projectRow: null });
    const data = await service.list(actor(), listFilter({ projectId: '404' }), normalizePageQuery({}));

    expect(data.total).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('按单个原型筛：原型 id 进条件，范围条件仍在', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(actor(), listFilter({ prototypeId: '31' }), normalizePageQuery({}));

    const call = rowsCallOf(fake);
    expect(call.sql).toContain('l.prototype_id = ?');
    expect(call.sql).toContain('l.prototype_id in (?,?)');
    expect(call.values).toContain(31n);
  });
});

// -----------------------------------------------------------------------------
// §6.1 降级展示：编码不存在 / 原型已删 / 项目查不到，只剩 routeKey
// -----------------------------------------------------------------------------

describe('§6.1 的降级展示', () => {
  it('原型已被删除：名字与 id 都空，routeKey 留着说明访问的是哪条路径', () => {
    const item = toAccessLogItem(rawRow({ prototype_deleted_at: new Date('2026-10-01T00:00:00Z') }), null);

    expect(item.prototypeId).toBeNull();
    expect(item.prototypeName).toBeNull();
    expect(item.prototypeCode).toBeNull();
    expect(item.routeKey).toBe('crm/crm-p01');
  });

  it('编码不存在（根本没有原型行）：同样只剩 routeKey', () => {
    const item = toAccessLogItem(
      rawRow({ prototype_code: null, prototype_id: null, prototype_name: null }),
      null,
    );

    expect([item.prototypeId, item.prototypeName, item.prototypeCode]).toEqual([null, null, null]);
    expect(item.routeKey).toBe('crm/crm-p01');
  });

  it('route_key 的首段对不上任何项目：项目列为空', () => {
    const item = toAccessLogItem(
      rawRow({ project_id: null, project_name: null, prototype_deleted_at: new Date() }),
      null,
    );

    expect(item.projectId).toBeNull();
    expect(item.projectName).toBeNull();
  });

  it('项目已软删：项目名同样降级为空（与原型侧同一条规则），但原型信息还在', () => {
    const item = toAccessLogItem(rawRow({ project_deleted_at: new Date('2026-10-02T00:00:00Z') }), null);

    expect(item.projectId).toBeNull();
    expect(item.projectName).toBeNull();
    expect(item.prototypeName).toBe('登录页演示');
  });

  it('版本行没了就没有版本号：日志不会因为版本被删而消失', () => {
    expect(toAccessLogItem(rawRow({ version_no: null }), null).versionNo).toBeNull();
    expect(toAccessLogItem(rawRow(), null).versionNo).toBe(3);
  });

  it('登录过的访问者显示用户名，匿名访问者为空（界面渲染"匿名"）', () => {
    const named = toAccessLogItem(rawRow({ user_id: 5n, visitor_name: 'zhangsan' }), null);
    expect([named.userId, named.visitorName]).toEqual(['5', 'zhangsan']);

    const anonymous = toAccessLogItem(rawRow(), null);
    expect([anonymous.userId, anonymous.visitorName]).toEqual([null, null]);
  });

  it('id 转字符串、时间转 ISO：bigint 不能直接进 JSON', () => {
    const item = toAccessLogItem(rawRow(), null);

    expect(item.id).toBe('9021');
    expect(item.createdAt).toBe('2026-10-06T06:30:00.000Z');
  });

  it('字典外的脏值降级而不是让整页打不开', () => {
    expect(toAccessLogResult('denied_500')).toBe('not_found');
    expect(toAccessLogResult('ok')).toBe('ok');
    expect(toAccessLogDevice('smart_tv')).toBeNull();
    expect(toAccessLogDevice('mobile')).toBe('mobile');
    expect(toAccessLogItem(rawRow({ result: 'denied_500' }), null).result).toBe('not_found');
  });

  it('明细行按 §6.1 的字段全量透出（列表页不再自己猜缺了谁）', async () => {
    const { service } = createService({ listRows: [rawRow()] });
    const data = await service.list(actor(), listFilter({}), normalizePageQuery({}));
    const item = data.items[0] as AccessLogItem;

    expect(Object.keys(item).sort()).toEqual(
      [
        'browser',
        'createdAt',
        'device',
        'id',
        'ip',
        'isBot',
        'os',
        'path',
        'projectId',
        'projectName',
        'prototypeCode',
        'prototypeId',
        'prototypeName',
        'referer',
        'result',
        'routeKey',
        'userId',
        'versionNo',
        'visitorName',
      ].sort(),
    );
    expect(item).toMatchObject({
      browser: 'Chrome 141',
      device: 'desktop',
      ip: '116.226.1.x',
      os: 'macOS 15',
      path: '/p/crm/crm-p01/',
      projectId: '9',
      projectName: 'CRM系统',
      prototypeId: '31',
      referer: 'https://chat.company.com/room/1',
      result: 'ok',
    });
  });

  it('keyword 对 IP 与 UA 同时模糊匹配，且通配符被转义', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(actor(), listFilter({ keyword: '10.%' }), normalizePageQuery({}));

    const call = rowsCallOf(fake);
    expect(call.sql).toContain('l.ip::text ilike ?');
    expect(call.sql).toContain('l.ua ilike ?');
    expect(call.values).toContain('%10.\\%%');
  });

  it('result 与时间区间原样进条件', async () => {
    const { fake, service } = createService({ listRows: [rawRow()] });
    await service.list(
      actor(),
      listFilter({
        endTime: '2026-10-06T23:59:59Z',
        result: 'denied_401',
        startTime: '2026-10-01T00:00:00Z',
      }),
      normalizePageQuery({}),
    );

    const values = rowsCallOf(fake).values;
    expect(values).toContain('denied_401');
    expect(values).toContainEqual(new Date('2026-10-01T00:00:00Z'));
    expect(values).toContainEqual(new Date('2026-10-06T23:59:59Z'));
  });

  it('总数按命中行数出，不受打码与降级影响', async () => {
    const { service } = createService({
      listRows: [rawRow(), rawRow({ id: 9022n, ip: null })],
      total: 128n,
    });
    const data = await service.list(actor(), listFilter({}), normalizePageQuery({}));

    expect(data.total).toBe(128);
    expect(data.items).toHaveLength(2);
    expect(data.items[1]?.ip).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §6.1/§6.2 参数校验
// -----------------------------------------------------------------------------

describe('查询参数校验', () => {
  /**
   * 联合类型而不是 `z.ZodTypeAny`：`parseWithSchema` 只要求"是个 schema"，但这里想钉死
   * "只有 §6.1/§6.2 这两个查询契约会被校验"，多传一个别处的 schema 就该在编译期报错。
   */
  type QueryValidator = typeof accessLogListQuerySchema | typeof accessLogSummaryQuerySchema;

  function expectInvalid(schema: QueryValidator, query: Record<string, unknown>): void {
    try {
      parseWithSchema(schema, query);
    } catch (error) {
      const exception = error as BusinessException;
      expect(exception).toBeInstanceOf(BusinessException);
      expect(exception.errorCode).toBe(ERROR_CODES.PARAM_INVALID);
      expect(exception.httpStatus).toBe(400);
      return;
    }
    throw new Error('参数校验没有抛 400');
  }

  it('result 写错直接 400，而不是"当作没筛"返回全量', () => {
    expectInvalid(accessLogListQuerySchema, { result: 'success' });
  });

  it('时间不是 ISO 串 → 400', () => {
    expectInvalid(accessLogListQuerySchema, { startTime: '2026年10月1日' });
  });

  it('开始时间晚于结束时间 → 400，不静默交换成另一个区间', () => {
    expectInvalid(accessLogListQuerySchema, {
      endTime: '2026-10-01T00:00:00Z',
      startTime: '2026-10-06T00:00:00Z',
    });
  });

  it('同一个键重复传（解析出来是数组）→ 400，而不是只用其中一个值', () => {
    expectInvalid(accessLogListQuerySchema, { result: ['ok', 'not_found'] });
  });

  it('id 类参数必须是数字串（前端传错不会变成 BigInt 构造异常）', () => {
    expectInvalid(accessLogListQuerySchema, { projectId: 'crm' });
  });

  it('空白值算"没填"而不是"填了个空字符串"', () => {
    expect(() =>
      accessLogListQuerySchema.parse({ keyword: '   ', maskIp: '', result: '' }),
    ).not.toThrow();
    expect(accessLogListQuerySchema.parse({ keyword: '   ', maskIp: '', result: '' })).toEqual({});
  });

  it('days 非数字 → 400（数字越界才走夹取）', () => {
    expectInvalid(accessLogSummaryQuerySchema, { days: 'seven' });
  });
});

// -----------------------------------------------------------------------------
// §6.2 汇总
// -----------------------------------------------------------------------------

describe('§6.2 的汇总口径', () => {
  it('五个指标各归各的：正常访问、被拦、无效链接、bot、独立访客', async () => {
    const { service } = createService({
      aggregate: { bot_pv: 41n, denied: 26n, invalid_pv: 7n, pv: 903n, uv: 118n },
    });
    const summary = await service.summary(actor({ dataScope: 'all' }), {});

    expect([summary.pv, summary.uv, summary.denied, summary.botPv, summary.invalidPv]).toEqual([
      903, 118, 26, 41, 7,
    ]);
  });

  it('窗口是"最近 N 个日历日含今天"，下界取当天零点往回推 N-1 天', () => {
    const window = buildSummaryWindow(7, new Date(2026, 9, 6, 23, 30));

    expect(window.start).toEqual(new Date(2026, 9, 0));
    expect(window.keys[0]).toBe('2026-09-30');
    expect(window.keys[6]).toBe('2026-10-06');
    expect(window.keys).toHaveLength(7);
  });

  it('汇总只按窗口下界过滤，不给上界（刚落的记录不该因为时钟差被切掉）', async () => {
    const { fake, service } = createService({});
    await service.summary(actor({ dataScope: 'all' }), { days: 7 });

    const call = fake.find('as invalid_pv');
    expect(call.sql).toContain('l.created_at >= ?');
    expect(call.sql).not.toContain('l.created_at <= ?');
    expect(call.values).toEqual([call.values[0]]);
    expect(call.values[0]).toBeInstanceOf(Date);
  });

  it('days 缺省 7', () => {
    expect(resolveSummaryDays(undefined)).toBe(7);
  });

  it('days 越界被夹到 1..90 而不是报错', () => {
    expect(resolveSummaryDays(0)).toBe(1);
    expect(resolveSummaryDays(-5)).toBe(1);
    expect(resolveSummaryDays(90)).toBe(90);
    expect(resolveSummaryDays(91)).toBe(90);
    expect(resolveSummaryDays(1000)).toBe(90);
    expect(resolveSummaryDays(NaN)).toBe(7);
  });

  it('没有记录的日期补 0，折线不会因为那几天没人访问就断档', async () => {
    const keys = recentKeys(3);
    const { service } = createService({
      daily: [{ day: noonOf((keys[1] ?? '')), pv: 12n, uv: 4n }],
    });

    const summary = await service.summary(actor({ dataScope: 'all' }), { days: 3 });

    expect(summary.daily).toEqual([
      { date: keys[0], pv: 0, uv: 0 },
      { date: keys[1], pv: 12, uv: 4 },
      { date: keys[2], pv: 0, uv: 0 },
    ]);
  });

  it('库里同一日历日出现多桶时相加而不是互相覆盖', () => {
    const day = noonOf('2026-10-05');
    // uv 相加会重复计同一个访客，但这是分桶口径出错时的兜底合并：宁可偏高也不丢一整桶的量
    expect(fillDaily(['2026-10-05'], [{ day, pv: 1n, uv: 1n }, { day, pv: 2n, uv: 1n }])).toEqual([
      { date: '2026-10-05', pv: 3, uv: 2 },
    ]);
  });

  it('原型榜只留取到名字的，顺序仍按次数从高到低', async () => {
    const { fake, service } = createService({
      namedPrototypes: [{ code: 'crm-p01', id: 31n, name: '登录页演示', project: { name: 'CRM系统' } }],
      topPrototypes: [
        { prototype_id: 31n, pv: 320n },
        { prototype_id: 99n, pv: 50n },
      ],
    });
    const summary = await service.summary(actor({ dataScope: 'all' }), {});

    expect(summary.topPrototypes).toEqual([
      { code: 'crm-p01', name: '登录页演示', projectName: 'CRM系统', prototypeId: '31', pv: 320 },
    ]);
    // 取名时排掉软删原型：那类行已经归 invalidPv，不该再冒充"某个原型被看了 N 次"
    expect(fake.prototypeQueries.at(-1)).toMatchObject({ where: { deletedAt: null } });
  });

  it('来源榜按 origin 出，解析不出来源的行不占名次', async () => {
    const { service } = createService({
      referers: [
        { origin: 'https://chat.company.com', pv: 210n },
        { origin: null, pv: 90n },
      ],
    });
    const summary = await service.summary(actor({ dataScope: 'all' }), {});

    expect(summary.topReferers).toEqual([{ pv: 210, referer: 'https://chat.company.com' }]);
  });

  it('筛某个原型时，指标、趋势、两张榜用的是同一套条件（卡片与折线不会各说一套）', async () => {
    const { fake, service } = createService({});
    await service.summary(actor({ dataScope: 'all' }), { days: 7, prototypeId: '31' });

    const markers = ['as invalid_pv', 'as day', 'group by l.prototype_id', 'as origin'];
    const windows: unknown[] = [];
    for (const marker of markers) {
      const values = fake.find(marker).values;
      expect(values).toContain(31n);
      windows.push(values.at(-1));
    }
    // 四次的窗口下界是同一个 Date：一次算错就是四个数各错各的
    expect(new Set(windows.map((value) => (value as Date).getTime())).size).toBe(1);
  });

  it('成员档的汇总同样带范围：viewer 看不到别人项目的流量', async () => {
    const { fake, service } = createService({
      scopeProjects: [{ code: 'crm' }],
      scopePrototypes: [{ id: 31n }],
    });
    await service.summary(actor(), { days: 7 });

    const call = fake.find('as invalid_pv');
    expect(call.sql).toContain('l.prototype_id in (?)');
    expect(call.values).toEqual([31n, 'crm', expect.any(Date)]);
  });

  it('范围内没有项目时回一份全 0 的汇总，但日期轴仍然按窗口补齐', async () => {
    const keys = recentKeys(2);
    const { fake, service } = createService({ scopeProjects: [], scopePrototypes: [] });
    const summary = await service.summary(actor(), { days: 2 });

    expect(summary).toEqual({
      botPv: 0,
      daily: [
        { date: keys[0], pv: 0, uv: 0 },
        { date: keys[1], pv: 0, uv: 0 },
      ],
      denied: 0,
      invalidPv: 0,
      pv: 0,
      topPrototypes: [],
      topReferers: [],
      uv: 0,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('localDateKey 补零，否则前端按日期排序会乱', () => {
    expect(localDateKey(new Date(2026, 0, 9))).toBe('2026-01-09');
  });
});

// -----------------------------------------------------------------------------
// §3.1 工作台的访问统计（计划 M5-T1）
// -----------------------------------------------------------------------------

describe('§3.1 工作台的访问统计', () => {
  /** 与 `DASHBOARD_TREND_DAYS` 同一条：14 个日历日桶，末 7 个是"近 7 天"，再往前 7 个是环比基线。 */
  const TREND_KEYS = buildSummaryWindow(14).keys;
  const keyOf = (index: number): Date => noonOf(TREND_KEYS[index] ?? '');

  it('三个访问量出自同一份日桶：今天=末桶、近 7 天=末 7 桶、上一个 7 天=再往前 7 桶', () => {
    const stats = toVisitStats(
      [
        { day: keyOf(2), pv: 5n, uv: 1n },
        { day: keyOf(6), pv: 3n, uv: 1n },
        { day: keyOf(9), pv: 7n, uv: 1n },
        { day: keyOf(13), pv: 4n, uv: 1n },
      ],
      TREND_KEYS,
      { denied: 26n, uv: 118n },
    );

    expect(stats).toEqual({
      deniedLast7d: 26,
      last7d: 11,
      previous7d: 8,
      today: 4,
      uvLast7d: 118,
    });
  });

  it('窗口外与"那天没人访问"的两种缺桶都是 0，不进任何一格', () => {
    const stats = toVisitStats(
      [
        { day: noonOf(localDateKey(localDayStart(-20))), pv: 99n, uv: 1n },
        { day: keyOf(11), pv: 2n, uv: 1n },
      ],
      TREND_KEYS,
      { denied: 0n, uv: 0n },
    );

    expect([stats.today, stats.last7d, stats.previous7d]).toEqual([0, 2, 0]);
  });

  it('库里同一天多出来的桶相加（与 §6.2 的 `fillDaily` 同一条合并规则，不各算一套）', () => {
    const day = keyOf(13);
    const stats = toVisitStats(
      [
        { day, pv: 1n, uv: 1n },
        { day, pv: 2n, uv: 1n },
      ],
      TREND_KEYS,
      { denied: 0n, uv: 0n },
    );

    expect([stats.today, stats.last7d]).toEqual([3, 3]);
  });

  it('只打两次库：日桶取 14 天的下界、汇总取 7 天的下界（差整整 7 个日历日）', async () => {
    const { fake, service } = createService({});
    await service.dashboardVisitStats(actor({ dataScope: 'all' }));

    expect(fake.calls).toHaveLength(2);
    const trendCall = fake.find('as day');
    const aggregateCall = fake.find('as invalid_pv');
    expect(localDateKey(trendCall.values.at(-1) as Date)).toBe(TREND_KEYS[0]);
    expect(localDateKey(aggregateCall.values.at(-1) as Date)).toBe(TREND_KEYS[7]);
  });

  it('member 档把可见范围带进这两次查询：工作台不是绕开数据权限的后门', async () => {
    const { fake, service } = createService({});
    await service.dashboardVisitStats(actor());

    for (const call of fake.calls) {
      expect(call.sql).toContain('l.prototype_id in (');
      expect(call.sql).toContain("split_part(l.route_key, '/', 1) in (");
      expect(call.values).toContain(31n);
      expect(call.values).toContain('crm');
    }
  });

  it('范围内没有项目时五个数全 0，一次库都不打', async () => {
    const { fake, service } = createService({ scopeProjects: [], scopePrototypes: [] });

    expect(await service.dashboardVisitStats(actor())).toEqual(emptyVisitStats());
    expect(fake.calls).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 控制器：参数解析与响应形状
// -----------------------------------------------------------------------------

describe('控制器（§6.1/§6.2 的入参与响应形状）', () => {
  it('page/pageSize 换算成 skip/take 交给服务层，响应是 {items,total}', async () => {
    const list = vi.fn(async () => ({ items: [toAccessLogItem(rawRow(), null)], total: 1 }));
    const controller = new AccessLogQueryController({ list } as unknown as AccessLogQueryService);

    const result = await controller.list(actor(), { page: '3', pageSize: '10' });

    expect(list).toHaveBeenCalledWith(
      actor(),
      expect.anything(),
      expect.objectContaining({ page: 3, pageSize: 10, skip: 20 }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe('9021');
  });

  it('参数不合法在进服务层之前就 400', async () => {
    const list = vi.fn();
    const controller = new AccessLogQueryController({ list } as unknown as AccessLogQueryService);

    await expect(controller.list(actor(), { result: 'nope' })).rejects.toBeInstanceOf(BusinessException);
    expect(list).not.toHaveBeenCalled();
  });

  it('汇总接口把原始 query 解析成 days/projectId 再交给服务层', async () => {
    const summary = vi.fn(async () => ({
      botPv: 0,
      daily: [],
      denied: 0,
      invalidPv: 0,
      pv: 0,
      topPrototypes: [],
      topReferers: [],
      uv: 0,
    }));
    const controller = new AccessLogQueryController({ summary } as unknown as AccessLogQueryService);

    await controller.summary(actor(), { days: '30', projectId: '9' });

    expect(summary).toHaveBeenCalledWith(actor(), { days: 30, projectId: '9' });
  });
});

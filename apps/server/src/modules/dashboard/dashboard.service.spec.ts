import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { localTodayStart, localWeekStart } from '../../common/calendar-window';
import type { ActorScope } from '../../common/data-scope';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import type { AccessLogQueryService } from '../accesslog/access-log.query.service';
import type { Actor } from '../system/common/actor';
import type { ProjectRepo } from '../project/project.repo';
import {
  PrototypeRepo,
  type PrototypeAggregates,
  type RecentPrototypeRow,
} from '../prototype/prototype.repo';
import type { VersionRepo } from '../release/version/version.repo';
import type { RecentReleaseEventRow } from '../release/version/version.repo';
import {
  DashboardService,
  RECENT_EVENT_LIMIT,
  RECENT_PROTOTYPE_LIMIT,
} from './dashboard.service';

/**
 * 工作台概览编排单测（后端接口设计 §3.1，计划 M5-T1）。
 *
 * 四个依赖全用桩，钉的是**只有编排这一层**负责的四件事：
 * 1. 六块数据各归各的出处（状态数走各自的 repo、访问统计走访问记录那一侧），不在这里现算；
 * 2. 可见性条件由编排层组好下发——发布数与最近动态拿到的是同一条"未软删 + 父项目可见"，
 *    范围条件带的是 BigInt 的 userId（`toActorScope` 那一处转换）；
 * 3. 两个列表的长度（5 / 10）；
 * 4. 出参形状：id 转字符串、时间转 ISO、`accessUrl` 由服务端按 `PUBLIC_BASE_URL` 拼好。
 * "按原型更新时间取而不是按项目"、"数据与项目列表能对上"这两条判据要落到真库才成立，
 * 归 `dashboard.overview.spec.ts`。
 */

const PROJECT_STATS = { archived: 2, draft: 3, published: 19, total: 24 };
const PROTOTYPE_STATS = { archived: 3, draft: 12, published: 71, total: 86 };
const RELEASE_STATS = { thisWeek: 7, today: 2 };
const VISIT_STATS = {
  deniedLast7d: 26,
  last7d: 903,
  previous7d: 858,
  today: 152,
  uvLast7d: 118,
};

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    dataScope: 'all',
    isSuperAdmin: true,
    roles: ['super_admin'],
    userId: '7',
    username: 'admin',
    ...overrides,
  };
}

function prototypeRow(id: bigint, overrides: Partial<RecentPrototypeRow> = {}): RecentPrototypeRow {
  const updatedAt = new Date('2026-10-06T02:00:00.000Z');
  return {
    accessMode: 'public',
    archivedAt: null,
    code: `crm-p${String(id)}`,
    createdAt: updatedAt,
    createdBy: 7n,
    currentReleaseId: null,
    description: null,
    firstPublishedAt: null,
    hasAccessPassword: false,
    id,
    name: `原型 ${String(id)}`,
    policyVersion: 1,
    projectCode: 'crm',
    projectId: 9n,
    projectName: 'CRM系统',
    publishedAt: null,
    sort: 0,
    status: 'published',
    updatedAt,
    ...overrides,
  };
}

function aggregates(visitsLast7d: number): PrototypeAggregates {
  return { currentRelease: null, releaseCount: 0, visitsLast7d };
}

function eventRow(id: bigint, overrides: Partial<RecentReleaseEventRow> = {}): RecentReleaseEventRow {
  return {
    createdAt: new Date('2026-10-06T03:00:00.000Z'),
    eventType: 'publish',
    id,
    operatorName: '张三',
    projectName: 'CRM系统',
    prototypeCode: 'crm-p01',
    prototypeName: '登录页演示',
    reason: null,
    ...overrides,
  };
}

interface Fakes {
  readonly accessLogs: { dashboardVisitStats: ReturnType<typeof vi.fn> };
  readonly projects: { statusCounts: ReturnType<typeof vi.fn> };
  readonly prototypes: {
    aggregatesFor: ReturnType<typeof vi.fn>;
    recentUpdated: ReturnType<typeof vi.fn>;
    statusCounts: ReturnType<typeof vi.fn>;
  };
  readonly versions: {
    listRecentEvents: ReturnType<typeof vi.fn>;
    publishedCounts: ReturnType<typeof vi.fn>;
  };
}

function createService(rows: readonly RecentPrototypeRow[] = []): {
  fakes: Fakes;
  service: DashboardService;
} {
  const fakes: Fakes = {
    accessLogs: { dashboardVisitStats: vi.fn(async () => VISIT_STATS) },
    projects: { statusCounts: vi.fn(async () => PROJECT_STATS) },
    prototypes: {
      aggregatesFor: vi.fn(async (list: readonly RecentPrototypeRow[]) => {
        const map = new Map<string, PrototypeAggregates>();
        for (const row of list) {
          map.set(row.id.toString(), aggregates(80 + Number(row.id)));
        }
        return map;
      }),
      recentUpdated: vi.fn(async () => rows),
      statusCounts: vi.fn(async () => PROTOTYPE_STATS),
    },
    versions: {
      listRecentEvents: vi.fn(async () => [eventRow(41n)]),
      publishedCounts: vi.fn(async () => RELEASE_STATS),
    },
  };
  const service = new DashboardService(
    fakes.projects as unknown as ProjectRepo,
    fakes.prototypes as unknown as PrototypeRepo,
    fakes.versions as unknown as VersionRepo,
    fakes.accessLogs as unknown as AccessLogQueryService,
    fakeAppEnv(),
  );
  return { fakes, service };
}

describe('§3.1 overview 的出处与形状', () => {
  it('六块数据原样进响应：状态数来自 repo，访问统计来自访问记录那一侧', async () => {
    const { fakes, service } = createService();
    const overview = await service.overview(actor());

    expect(overview).toEqual({
      projectStats: PROJECT_STATS,
      prototypeStats: PROTOTYPE_STATS,
      recentEvents: [
        {
          createdAt: '2026-10-06T03:00:00.000Z',
          eventType: 'publish',
          id: '41',
          operatorName: '张三',
          projectName: 'CRM系统',
          prototypeCode: 'crm-p01',
          prototypeName: '登录页演示',
          reason: null,
        },
      ],
      recentPrototypes: [],
      releaseStats: RELEASE_STATS,
      visitStats: VISIT_STATS,
    });
    expect(fakes.accessLogs.dashboardVisitStats).toHaveBeenCalledWith(actor());
  });

  it('两个列表把契约里的长度交给出处去取：5 个原型、10 条动态', async () => {
    const { fakes, service } = createService();
    await service.overview(actor());

    expect([RECENT_PROTOTYPE_LIMIT, RECENT_EVENT_LIMIT]).toEqual([5, 10]);
    expect(fakes.prototypes.recentUpdated).toHaveBeenCalledWith(
      expect.anything(),
      RECENT_PROTOTYPE_LIMIT,
    );
    expect(fakes.versions.listRecentEvents).toHaveBeenCalledWith(
      expect.anything(),
      RECENT_EVENT_LIMIT,
    );
  });

  it('recentPrototypes 一行同时带项目名、服务端拼好的访问地址与近 7 天访问量', async () => {
    const env = fakeAppEnv();
    const { fakes, service } = createService([prototypeRow(31n)]);
    fakes.prototypes.aggregatesFor.mockResolvedValue(new Map([['31', aggregates(88)]]));

    const overview = await service.overview(actor());

    expect(overview.recentPrototypes).toEqual([
      {
        accessUrl: `${env.env.http.publicBaseUrl}/p/crm/crm-p31`,
        code: 'crm-p31',
        id: '31',
        name: '原型 31',
        projectId: '9',
        projectName: 'CRM系统',
        status: 'published',
        updatedAt: '2026-10-06T02:00:00.000Z',
        visitsLast7d: 88,
      },
    ]);
    // 访问量与列表页同源：复用一次 `aggregatesFor`，不在这里另开一条 7 天窗口
    expect(fakes.prototypes.aggregatesFor).toHaveBeenCalledWith([prototypeRow(31n)]);
  });

  it('聚合缺行时访问量给 0，而不是 undefined（卡片不该出现 NaN）', async () => {
    const { fakes, service } = createService([prototypeRow(31n)]);
    fakes.prototypes.aggregatesFor.mockResolvedValue(new Map());

    const [item] = (await service.overview(actor())).recentPrototypes;

    expect(item?.visitsLast7d).toBe(0);
  });

  it('发布统计的窗口是"本地日历周一起点 + 今天零点"', async () => {
    const { fakes, service } = createService();
    await service.overview(actor());

    expect(fakes.versions.publishedCounts.mock.calls[0]?.[1]).toEqual({
      thisWeekStart: localWeekStart(),
      todayStart: localTodayStart(),
    });
  });
});

describe('§3.1 的数据权限', () => {
  /** `andPrototypeScope` 恒带父项目未软删那一支（计划 §8 F-6），范围条件叠在它里面。 */
  const ALL_WHERE = { deletedAt: null, project: { deletedAt: null } } satisfies Prisma.ProtoPrototypeWhereInput;

  it('范围条件由编排层组好下发：发布数与最近动态拿到的是同一条', async () => {
    const { fakes, service } = createService();
    await service.overview(actor());

    expect(fakes.versions.publishedCounts.mock.calls[0]?.[0]).toEqual(ALL_WHERE);
    expect(fakes.versions.listRecentEvents.mock.calls[0]?.[0]).toEqual(ALL_WHERE);
    expect(fakes.prototypes.recentUpdated.mock.calls[0]?.[0]).toEqual({
      dataScope: 'all',
      userId: 7n,
    });
  });

  it('member 档把 BigInt 的 userId 带进父项目条件（与列表那侧同一个形状，不给工作台留后门）', async () => {
    const { fakes, service } = createService();
    await service.overview(actor({ dataScope: 'member', isSuperAdmin: false, roles: ['viewer'] }));

    const where = fakes.versions.listRecentEvents.mock.calls[0]?.[0] as Prisma.ProtoPrototypeWhereInput;
    expect(where).toEqual({
      deletedAt: null,
      project: {
        deletedAt: null,
        OR: [{ createdBy: 7n }, { members: { some: { userId: 7n } } }],
      },
    });
  });

  it('状态数按范围算：两个 repo 各自数，不在编排层相加', async () => {
    const { fakes, service } = createService();
    const scope: ActorScope = { dataScope: 'all', userId: 7n };
    await service.overview(actor());

    expect(fakes.projects.statusCounts).toHaveBeenCalledWith(scope);
    expect(fakes.prototypes.statusCounts).toHaveBeenCalledWith(scope);
  });
});

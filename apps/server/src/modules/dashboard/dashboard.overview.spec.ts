/**
 * 工作台概览集成测试（迭代实施计划 M5-T1 的两条判据；§3.6：真库 `protohub_test`，不启 Nest、不占端口）。
 *
 * 与单测的分工：`dashboard.service.spec.ts` 把四个依赖全换成桩，钉的是编排那一层的四件事；
 * 这里钉的是**只有真库才验得了**的那两句判据原文：
 * 1. **数据与项目列表能对上**——`statusCounts` 与列表页的 `findPaged` 是两条不同的查询路径，
 *    同一批行必须给出同样的数（单测里两边都是桩，"对得上"是恒真，等于没验）；
 * 2. **`recentPrototypes` 按原型取而不是按项目**——要跨项目摆出交错的时间序，
 *    还要有"更新得更晚反而不进栏"的反例（软删的原型、软删项目下的原型、别人建的原型）。
 * 发布数、最近动态、访问统计三块同样按反例钉：越界的那些行**确实插在库里**，
 * 否则数字断言会因为"根本没插进去"而空过（反证基线）。
 *
 * 隔离：跑在共享测试库上，所以三个 actor 一律 `dataScope: 'own'` + `RUN` 随机后缀——
 * 范围条件把每一块数字都圈在本运行创建的那几行内，别的运行与 seed 数据都不参与。
 * 收尾只删自己创建的行（顺序：访问记录 → 事件 → 版本 → 原型 → 项目 → 用户），绝不 truncate。
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createPrismaClient } from '@protohub/db';

// 复用 seed.spec 的测试库护栏（packages/db/src/seed/guard.ts）：不是 *_test 库直接拒跑。
import {
  assertTestDatabase,
  databaseNameOf,
} from '../../../../../packages/db/src/seed/guard';

import {
  localDayStart,
  localTodayStart,
  localWeekStart,
} from '../../common/calendar-window';
import { toActorScope } from '../../common/data-scope';
import { normalizePageQuery } from '../../common/pagination/pagination';
import { PermissionCodeService } from '../../common/permission/permission-code.service';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import { AccessLogQueryRepo } from '../accesslog/access-log.query.repo';
import {
  ACCESS_LOG_SUMMARY_DEFAULT_DAYS,
  AccessLogQueryService,
} from '../accesslog/access-log.query.service';
import { ProjectRepo } from '../project/project.repo';
import { PrototypeRepo } from '../prototype/prototype.repo';
import { VersionRepo } from '../release/version/version.repo';
import type { Actor } from '../system/common/actor';
import { DashboardService } from './dashboard.service';

// 优先级与 release-pipeline.spec / seed.spec 完全一致。
const targetUrl = (() => {
  const candidate =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL && databaseNameOf(process.env.DATABASE_URL).endsWith('_test')
      ? process.env.DATABASE_URL
      : undefined) ??
    'postgresql://postgres:postgres@127.0.0.1:5432/protohub_test?schema=public';
  assertTestDatabase(candidate);
  return candidate;
})();

/** 本次运行的唯一标识：编码只允许小写字母/数字/短横线，hex 前缀 `it` 刚好合规。 */
const RUN = `it${randomBytes(4).toString('hex')}`;

/**
 * 日历日刻度：位移一律走 `localDayStart`（用 86400000 毫秒粗算在跨夏令时的那天会差一小时，
 * `common/calendar-window` 写了理由），小时加在"那天零点"之后，落点必然还在同一天里。
 *
 * 「今天」那一批一律放正午而不是贴着现在：`date_trunc('day', …)` 按数据库会话时区分桶，
 * `localDateKey` 按进程时区出标签，两个时区一旦不同，凌晨跑的测试就会把"现在"那条分到昨天，
 * 于是同一份代码随机红。正午那点在两侧时区下都还落在同一天。
 */
const dayAt = (offsetDays: number, hours: number): Date =>
  new Date(localDayStart(offsetDays).getTime() + hours * 3_600_000);
const TODAY = dayAt(0, 12);
const LAST_WEEK = dayAt(-7, 2);
const NOW = new Date();
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const secondsAgo = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1_000);

/**
 * 本周里有没有"昨天"可放：周一跑的时候 `localWeekStart() === localTodayStart()`，
 * "在本周内但不在今天"这一档根本不存在——那就整条不造，而不是把期望值写死成 3。
 */
const HAS_EARLIER_THIS_WEEK = localWeekStart().getTime() < localTodayStart().getTime();

let prisma: PrismaClient;
let dashboard: DashboardService;
let projects: ProjectRepo;
let prototypes: PrototypeRepo;
let accessLogs: AccessLogQueryService;
let publicBaseUrl: string;

let userA: Actor;
let userB: Actor;
let userC: Actor;
let userAId: bigint;
let userBId: bigint;
let userCId: bigint;

// fixture 行的 id（`let` + beforeAll 赋值，同 release-pipeline.spec 的做法）。
let p1Id: bigint;
let p2Id: bigint;
let p3Id: bigint;
let pbId: bigint;
let p1PublishedId: bigint;
let p1DraftId: bigint;
let p2ArchivedId: bigint;
let p2DraftOtherId: bigint;
let p2DraftOldestId: bigint;
let p3DraftId: bigint;
let p1DeletedProtoId: bigint;
let p4ProtoId: bigint;
let bProtoId: bigint;

/** 本运行创建的行，`afterAll` 按这份清单删回去。 */
const projectIds: bigint[] = [];
const prototypeIds: bigint[] = [];
const logIds: bigint[] = [];
let rowsCreated = false;

const PROJECT_CODE = {
  archived: `${RUN}-3`,
  deleted: `${RUN}-4`,
  p1: `${RUN}-1`,
  p2: `${RUN}-2`,
  userB: `${RUN}-9`,
};
const PROTO_CODE = {
  b: `${RUN}-x1`,
  p1Deleted: `${RUN}-a3`,
  p1Draft: `${RUN}-a2`,
  p1Published: `${RUN}-a1`,
  p2Archived: `${RUN}-b1`,
  p2DraftOldest: `${RUN}-b3`,
  p2DraftOther: `${RUN}-b2`,
  p3Draft: `${RUN}-c1`,
  p4Published: `${RUN}-d1`,
};
const PROJECT_NAME = {
  p1: `项目一 ${RUN}`,
  p2: `项目二 ${RUN}`,
  p3: `项目三 ${RUN}`,
};

async function makeProject(
  code: string,
  createdBy: bigint,
  name: string,
  extra: Partial<Prisma.ProtoProjectUncheckedCreateInput> = {},
): Promise<bigint> {
  const row = await prisma.protoProject.create({
    data: { archivedAt: null, code, createdBy, deletedAt: null, name, ...extra },
    select: { id: true },
  });
  projectIds.push(row.id);
  return row.id;
}

async function makePrototype(
  code: string,
  createdBy: bigint,
  name: string,
  projectId: bigint,
  extra: Partial<Prisma.ProtoPrototypeUncheckedCreateInput> = {},
): Promise<bigint> {
  const row = await prisma.protoPrototype.create({
    data: { code, createdBy, deletedAt: null, name, projectId, ...extra },
    select: { id: true },
  });
  prototypeIds.push(row.id);
  return row.id;
}

let releaseSeq = 0;
async function makeRelease(
  createdBy: bigint,
  createdAt: Date,
  prototypeId: bigint,
  extra: Partial<Prisma.ProtoReleaseUncheckedCreateInput> = {},
): Promise<bigint> {
  releaseSeq += 1;
  const hash = String(releaseSeq).padStart(64, '0');
  const row = await prisma.protoRelease.create({
    data: {
      contentHash: hash,
      createdAt,
      createdBy,
      fileCount: 1,
      manifest: {},
      prototypeId,
      sourceHash: hash,
      sourceSize: 1024n,
      storageKey: `releases/integration/${RUN}/${releaseSeq}`,
      totalBytes: 2048n,
      versionNo: releaseSeq,
      ...extra,
    },
    select: { id: true },
  });
  return row.id;
}

async function makeEvent(
  operatorId: bigint,
  prototypeId: bigint,
  createdAt: Date,
  reason: string,
): Promise<bigint> {
  const row = await prisma.protoReleaseEvent.create({
    data: { createdAt, eventType: 'publish', operatorId, prototypeId, reason },
    select: { id: true },
  });
  return row.id;
}

let logSeq = 0;
async function makeLog(
  routeKey: string,
  result: string,
  createdAt: Date,
  extra: Partial<Prisma.ProtoAccessLogUncheckedCreateInput> = {},
): Promise<void> {
  logSeq += 1;
  const row = await prisma.protoAccessLog.create({
    data: {
      createdAt,
      ip: `203.0.113.${logSeq}`,
      path: `/p/${routeKey}`,
      result,
      routeKey,
      ua: `Mozilla/5.0 (case-${logSeq})`,
      ...extra,
    },
    select: { id: true },
  });
  logIds.push(row.id);
}

beforeAll(async () => {
  prisma = createPrismaClient(targetUrl);

  const env = fakeAppEnv();
  publicBaseUrl = env.env.http.publicBaseUrl;

  projects = new ProjectRepo(prisma);
  prototypes = new PrototypeRepo(prisma);
  accessLogs = new AccessLogQueryService(
    prisma,
    new AccessLogQueryRepo(prisma),
    new PermissionCodeService(prisma),
  );
  dashboard = new DashboardService(projects, prototypes, new VersionRepo(prisma), accessLogs, env);

  const mkUser = async (tag: string, realName: string) =>
    prisma.sysUser.create({
      data: {
        passwordHash: 'integration-test-no-login',
        realName,
        username: `it-dash-${tag}-${RUN}`,
      },
      select: { id: true, username: true },
    });
  const a = await mkUser('a', `工作台测试 A ${RUN}`);
  const b = await mkUser('b', `工作台测试 B ${RUN}`);
  const c = await mkUser('c', `工作台测试 C ${RUN}`);
  userAId = a.id;
  userBId = b.id;
  userCId = c.id;
  // `own`：范围条件就是 `created_by = 我`，本运行的每一块数字都与别的运行无关。
  const actorOf = (user: { id: bigint; username: string }): Actor => ({
    dataScope: 'own',
    isSuperAdmin: false,
    roles: ['publisher'],
    userId: user.id.toString(),
    username: user.username,
  });
  userA = actorOf(a);
  userB = actorOf(b);
  userC = actorOf(c);
  rowsCreated = true;

  // --- 项目：P1 已发布 / P2 草稿 / P3 归档 / P4 已软删（反例）/ B 的一个项目 ---
  p1Id = await makeProject(PROJECT_CODE.p1, userAId, PROJECT_NAME.p1);
  p2Id = await makeProject(PROJECT_CODE.p2, userAId, PROJECT_NAME.p2);
  p3Id = await makeProject(PROJECT_CODE.archived, userAId, PROJECT_NAME.p3, {
    archivedAt: minutesAgo(90),
  });
  const p4Id = await makeProject(PROJECT_CODE.deleted, userAId, '项目四已删', {
    deletedAt: minutesAgo(120),
  });
  pbId = await makeProject(PROJECT_CODE.userB, userBId, 'B 的项目');

  // --- 原型：A 看得见的六个，`updatedAt` 决定工作台左栏那五个是谁、谁被截掉 ---
  // 倒序：P1发布(-1) → P2下架(-2) → P3草稿(-3) → P1草稿(-4) → P2草稿乙(-5) → P2最旧草稿(-6)
  // 项目编码依次是 P1、P2、P3、P1、P2 —— 交错到不可能"按项目分组"，第六个被 limit 截掉。
  p1PublishedId = await makePrototype(PROTO_CODE.p1Published, userAId, '已发布原型', p1Id, {
    status: 'published',
    updatedAt: minutesAgo(1),
  });
  p2ArchivedId = await makePrototype(PROTO_CODE.p2Archived, userAId, '下架原型', p2Id, {
    archivedAt: minutesAgo(70),
    status: 'archived',
    updatedAt: minutesAgo(2),
  });
  p3DraftId = await makePrototype(PROTO_CODE.p3Draft, userAId, 'P3 草稿', p3Id, {
    updatedAt: minutesAgo(3),
  });
  p1DraftId = await makePrototype(PROTO_CODE.p1Draft, userAId, '草稿原型', p1Id, {
    updatedAt: minutesAgo(4),
  });
  p2DraftOtherId = await makePrototype(PROTO_CODE.p2DraftOther, userAId, 'P2 草稿乙', p2Id, {
    updatedAt: minutesAgo(5),
  });
  p2DraftOldestId = await makePrototype(PROTO_CODE.p2DraftOldest, userAId, 'P2 最旧草稿', p2Id, {
    updatedAt: minutesAgo(6),
  });

  // --- 三件"更新得更晚却都不该进栏"的反例 ---
  p1DeletedProtoId = await makePrototype(PROTO_CODE.p1Deleted, userAId, '已软删的发布原型', p1Id, {
    deletedAt: minutesAgo(3),
    status: 'published',
    updatedAt: NOW,
  });
  p4ProtoId = await makePrototype(PROTO_CODE.p4Published, userAId, '软删项目下的原型', p4Id, {
    status: 'published',
    updatedAt: secondsAgo(20),
  });
  bProtoId = await makePrototype(PROTO_CODE.b, userBId, 'B 的发布原型', pbId, {
    status: 'published',
    updatedAt: secondsAgo(40),
  });

  // --- 版本行：今天两条 + 本周更早一条；上周 / 已删版本 / 不可见原型 / 别人原型各一条反例 ---
  await makeRelease(userAId, TODAY, p1PublishedId);
  await makeRelease(userAId, TODAY, p2ArchivedId);
  if (HAS_EARLIER_THIS_WEEK) {
    await makeRelease(userAId, new Date(localWeekStart().getTime() + 2 * 3_600_000), p1DraftId);
  }
  await makeRelease(userAId, LAST_WEEK, p1PublishedId);
  await makeRelease(userAId, TODAY, p1PublishedId, { deletedAt: minutesAgo(5) });
  await makeRelease(userAId, TODAY, p1DeletedProtoId);
  await makeRelease(userAId, TODAY, p4ProtoId);
  // createdBy 是 A、原型属 B：`releaseStats` 只看原型的可见性，这一条对 A 不该算（对 B 要算）。
  await makeRelease(userAId, TODAY, bProtoId);

  // --- 版本事件：A 可见 12 条（被 limit 10 截断）+ 2 条更新却不可见的反例 ---
  await makeEvent(userAId, p1DeletedProtoId, NOW, '软删原型上的事件不该进栏');
  await makeEvent(userAId, bProtoId, secondsAgo(30), '别人原型上的事件不该进栏');
  const eventTargets: bigint[] = [];
  for (let round = 0; round < 4; round += 1) {
    eventTargets.push(p1PublishedId, p2ArchivedId, p1DraftId);
  }
  for (const [index, prototypeId] of eventTargets.entries()) {
    await makeEvent(userAId, prototypeId, secondsAgo(60 + index * 30), `工作台事件 ${index}`);
  }

  // --- 访问记录：只有入口访问写 ok（机制 §6）；UV 按 (本地日, ip, ua) 去重且不计 bot ---
  const ALPHA = 'Mozilla/5.0 (alpha)';
  // 今天：P1 已发布原型 三条 ok（前两条同一个访客）+ 一条 bot ok + 一条被拒。
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'ok', TODAY, {
    ip: '203.0.113.10',
    prototypeId: p1PublishedId,
    ua: ALPHA,
  });
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'ok', TODAY, {
    ip: '203.0.113.10',
    prototypeId: p1PublishedId,
    ua: ALPHA,
  });
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'ok', TODAY, {
    ip: '203.0.113.11',
    prototypeId: p1PublishedId,
    ua: ALPHA,
  });
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'ok', TODAY, {
    device: 'bot',
    ip: '203.0.113.99',
    isBot: true,
    prototypeId: p1PublishedId,
    ua: 'protohub-indexer/1.0 (+https://example.test/bot)',
  });
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'denied_401', TODAY, {
    ip: '203.0.113.30',
    prototypeId: p1PublishedId,
  });
  // P1 草稿原型今天一次（那一列的近 7 天访问量该是 1）。
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Draft}`, 'ok', TODAY, {
    ip: '198.51.100.5',
    prototypeId: p1DraftId,
  });
  // 软删原型上的"旧链接还在被访问"：visitStats 计（§6.1 那条不筛 deletedAt 的规则），
  // 但它本人不进 recentPrototypes——两件事分别由这两块断言钉住。
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Deleted}`, 'ok', TODAY, {
    ip: '198.51.100.6',
    prototypeId: p1DeletedProtoId,
  });
  // prototype_id 为空、只有 route_key 的无效链接：靠项目编码那半边命中。
  await makeLog(`${PROJECT_CODE.p1}/gone`, 'ok', TODAY, {
    ip: '203.0.113.20',
    prototypeId: null,
  });
  // 软删项目下的原型：走 prototype_id 那半边命中（范围集合与其父项目一起解析）。
  await makeLog(`${PROJECT_CODE.deleted}/${PROTO_CODE.p4Published}`, 'ok', TODAY, {
    ip: '203.0.113.40',
    prototypeId: p4ProtoId,
  });
  // 别人的原型：对 A 一条都不该算（B 那侧只剩这一条）。
  await makeLog(`${PROJECT_CODE.userB}/${PROTO_CODE.b}`, 'ok', TODAY, {
    ip: '203.0.113.50',
    prototypeId: bProtoId,
    ua: ALPHA,
  });
  // 上一个 7 天窗口（日历日 -8）：进 previous7d 做环比分母，同时也在滚动 7×24h 之外，
  // 所以"近 7 天访问量"那一列不该有它。
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`, 'ok', dayAt(-8, 12), {
    ip: '203.0.113.60',
    prototypeId: p1PublishedId,
    ua: ALPHA,
  });
  await makeLog(`${PROJECT_CODE.p1}/${PROTO_CODE.p1Draft}`, 'ok', dayAt(-8, 13), {
    ip: '203.0.113.61',
    prototypeId: p1DraftId,
  });
}, 30_000);

afterAll(async () => {
  try {
    if (rowsCreated) {
      await prisma.protoAccessLog.deleteMany({ where: { id: { in: logIds } } });
      await prisma.protoReleaseEvent.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
      await prisma.protoRelease.deleteMany({ where: { prototypeId: { in: prototypeIds } } });
      await prisma.protoPrototype.deleteMany({ where: { id: { in: prototypeIds } } });
      await prisma.protoProject.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.sysUser.deleteMany({ where: { id: { in: [userAId, userBId, userCId] } } });
    }
  } finally {
    // 清理失败必须可见（漏行就是污染共享测试库），但连接仍要收尾。
    await prisma?.$disconnect();
  }
}, 30_000);

describe('判据①：工作台的数字与项目/原型列表能对上（两条查询路径，同一批行）', () => {
  it('projectStats 三项与总数逐项等于项目列表按状态筛出来的 total', async () => {
    const overview = await dashboard.overview(userA);
    const scope = toActorScope(userA);
    const page = normalizePageQuery({ page: 1, pageSize: 100 });

    expect(overview.projectStats).toEqual({ archived: 1, draft: 1, published: 1, total: 3 });
    for (const status of ['archived', 'draft', 'published'] as const) {
      const listed = await projects.findPaged(scope, { status }, page);
      expect(listed.total, `项目列表 status=${status}`).toBe(overview.projectStats[status]);
    }
    const all = await projects.findPaged(scope, {}, page);
    expect(all.total).toBe(overview.projectStats.total);
    // 软删的项目在两条路径上都不出现：不是"工作台少算"，而是"两边都不算"。
    expect(all.rows.map((row) => row.code)).not.toContain(PROJECT_CODE.deleted);
  });

  it('prototypeStats 等于逐项目原型列表按状态筛的合计', async () => {
    const overview = await dashboard.overview(userA);
    const scope = toActorScope(userA);
    const page = normalizePageQuery({ page: 1, pageSize: 100 });

    expect(overview.prototypeStats).toEqual({ archived: 1, draft: 4, published: 1, total: 6 });
    for (const status of ['archived', 'draft', 'published'] as const) {
      let listed = 0;
      for (const projectId of [p1Id, p2Id, p3Id]) {
        const result = await prototypes.findPaged(scope, { projectId, status }, page);
        listed += result.total;
      }
      expect(listed, `原型列表 status=${status}`).toBe(overview.prototypeStats[status]);
    }
  });

  it('近 7 天访问量那一列与原型列表页的聚合值是同一个数', async () => {
    const overview = await dashboard.overview(userA);
    const scope = toActorScope(userA);
    const listed = await prototypes.findPaged(
      scope,
      { projectId: p1Id },
      normalizePageQuery({ page: 1, pageSize: 100 }),
    );

    // 四条 ok（含那条 bot——这一列的口径归 `entryVisitsByPrototype`，工作台不另开一份），
    // 日历日 -8 的那条在滚动 7×24h 之外所以不加分；两条入口必须给同一个 4。
    // 聚合 Map 的键是字符串 id（接口出参也是字符串），所以这里同样按字符串取。
    expect(listed.aggregates.get(p1PublishedId.toString())?.visitsLast7d).toBe(4);
    expect(
      overview.recentPrototypes.find((row) => row.code === PROTO_CODE.p1Published)?.visitsLast7d,
    ).toBe(4);
    expect(listed.aggregates.get(p1DraftId.toString())?.visitsLast7d).toBe(1);
    expect(
      overview.recentPrototypes.find((row) => row.code === PROTO_CODE.p1Draft)?.visitsLast7d,
    ).toBe(1);
  });

  it('范围内什么都没有的人：六块都是 0/空，而不是缺一块（前端设计 §10.2）', async () => {
    expect(await dashboard.overview(userC)).toEqual({
      projectStats: { archived: 0, draft: 0, published: 0, total: 0 },
      prototypeStats: { archived: 0, draft: 0, published: 0, total: 0 },
      recentEvents: [],
      recentPrototypes: [],
      releaseStats: { thisWeek: 0, today: 0 },
      visitStats: { deniedLast7d: 0, last7d: 0, previous7d: 0, today: 0, uvLast7d: 0 },
    });
  });
});

describe('判据②：recentPrototypes 按原型自己的更新时间取，不是按项目', () => {
  it('五个位置的项目编码交错；第六个原型被截掉；三件更新得更晚的反例都不在', async () => {
    const { recentPrototypes } = await dashboard.overview(userA);

    expect(recentPrototypes.map((row) => row.code)).toEqual([
      PROTO_CODE.p1Published,
      PROTO_CODE.p2Archived,
      PROTO_CODE.p3Draft,
      PROTO_CODE.p1Draft,
      PROTO_CODE.p2DraftOther,
    ]);
    // 按项目取的话，第二、三项必然同属 P2（P2 里两个原型的更新时间紧接在 P1 那个之后）——
    // 这正是判据点名的错法，所以项目编码这一列本身就是断言。
    expect(recentPrototypes.map((row) => row.projectName)).toEqual([
      PROJECT_NAME.p1,
      PROJECT_NAME.p2,
      PROJECT_NAME.p3,
      PROJECT_NAME.p1,
      PROJECT_NAME.p2,
    ]);
    expect(recentPrototypes.map((row) => row.status)).toEqual([
      'published',
      'archived',
      'draft',
      'draft',
      'draft',
    ]);

    // 反例三件的 updatedAt 分别是 NOW / -20s / -40s，全都排在最前，却一个都不进栏
    // （断 id 而不是断编码：id 才是"那一行"，编码撞不上时测试会假绿）。
    const returnedIds = recentPrototypes.map((row) => row.id);
    expect(returnedIds).toEqual([
      p1PublishedId.toString(),
      p2ArchivedId.toString(),
      p3DraftId.toString(),
      p1DraftId.toString(),
      p2DraftOtherId.toString(),
    ]);
    expect(returnedIds).not.toContain(p1DeletedProtoId.toString());
    expect(returnedIds).not.toContain(p4ProtoId.toString());
    expect(returnedIds).not.toContain(bProtoId.toString());
    // 被 limit 截掉的是最旧的那个原型，不是"某个项目的原型"。
    expect(returnedIds).not.toContain(p2DraftOldestId.toString());
  });

  it('出参形状：accessUrl 由服务端按项目编码+原型编码拼好，时间是 ISO，id 是字符串', async () => {
    const { recentPrototypes } = await dashboard.overview(userA);

    expect(recentPrototypes[0]).toMatchObject({
      accessUrl: `${publicBaseUrl}/p/${PROJECT_CODE.p1}/${PROTO_CODE.p1Published}`,
      name: '已发布原型',
      projectId: p1Id.toString(),
      projectName: PROJECT_NAME.p1,
      status: 'published',
      visitsLast7d: 4,
    });
    expect(recentPrototypes[0]?.updatedAt).toBe(minutesAgo(1).toISOString());
    expect(recentPrototypes[0]?.id).toBe(p1PublishedId.toString());
  });
});

describe('releaseStats：可见范围内本周/今天新落地的版本行数', () => {
  it('今天的两条、本周的三条（非周一时）；上周/已删版本/不可见原型上的都不算', async () => {
    // 反证基线：八条（周一七条）版本行都真的在库里，否则下面的数字是空过。
    expect(
      await prisma.protoRelease.count({ where: { prototypeId: { in: prototypeIds } } }),
    ).toBe(HAS_EARLIER_THIS_WEEK ? 8 : 7);

    expect((await dashboard.overview(userA)).releaseStats).toEqual({
      thisWeek: HAS_EARLIER_THIS_WEEK ? 3 : 2,
      today: 2,
    });
  });

  it('窗口用的是本地日历周（周一起点）与本地今天零点，而不是滚动 7×24h', () => {
    // 这一条不查库，只钉窗口本身是日历值：它是 `publishedCounts` 唯一的入参。哪天换成
    // `now - 7*24h`，这条会红，而上面的数字用例还在绿（因为八条行的相对位置没变）。
    expect(localWeekStart().getDay()).toBe(1);
    expect(localTodayStart().getTime()).toBe(localDayStart(0).getTime());
    expect(localWeekStart().getTime()).toBeLessThanOrEqual(localTodayStart().getTime());
  });
});

describe('recentEvents：最近 10 条可见版本事件，每行自带项目与原型名', () => {
  it('12 条可见事件被截成 10 条且时间倒序；两条更新却不可见的都不在', async () => {
    const { recentEvents } = await dashboard.overview(userA);

    expect(recentEvents).toHaveLength(10);
    // 造的时候按 [P1发布, P2下架, P1草稿] 轮转、每条往前 30 秒，所以前十名的归属是确定的。
    expect(recentEvents.map((row) => row.prototypeCode)).toEqual([
      PROTO_CODE.p1Published,
      PROTO_CODE.p2Archived,
      PROTO_CODE.p1Draft,
      PROTO_CODE.p1Published,
      PROTO_CODE.p2Archived,
      PROTO_CODE.p1Draft,
      PROTO_CODE.p1Published,
      PROTO_CODE.p2Archived,
      PROTO_CODE.p1Draft,
      PROTO_CODE.p1Published,
    ]);
    const times = recentEvents.map((row) => Date.parse(row.createdAt));
    expect([...times].sort((left, right) => right - left)).toEqual(times);
    expect(recentEvents.at(-1)?.reason).toBe('工作台事件 9');

    expect(recentEvents.map((row) => row.prototypeCode)).not.toContain(PROTO_CODE.p1Deleted);
    expect(recentEvents.map((row) => row.prototypeCode)).not.toContain(PROTO_CODE.b);
    expect(recentEvents.every((row) => row.eventType === 'publish')).toBe(true);
    expect(recentEvents.every((row) => row.operatorName === `工作台测试 A ${RUN}`)).toBe(true);
    // 跨项目的一行必须自己说明属谁：项目名跟着原型走，不是整屏同一个项目名。
    expect(recentEvents[0]?.projectName).toBe(PROJECT_NAME.p1);
    expect(recentEvents[1]?.projectName).toBe(PROJECT_NAME.p2);
  });

  it('B 的工作台只看见自己那一条动态，A 的十二条一条都不漏过来', async () => {
    const { recentEvents } = await dashboard.overview(userB);
    expect(recentEvents.map((row) => row.reason)).toEqual(['别人原型上的事件不该进栏']);
  });
});

describe('visitStats：与访问记录页同一把尺子（日历日窗口 + UV 去重 + bot 不进 UV）', () => {
  it('今天八条 pv / UV 六个访客 / 被拒一条；上一个 7 天窗口两条', async () => {
    expect(logIds).toHaveLength(12);

    expect((await dashboard.overview(userA)).visitStats).toEqual({
      deniedLast7d: 1,
      // 八条 ok：P1发布 三条（含同访客两条）+ bot 一条（进 pv 不进 uv）+ P1草稿 一条
      // + 软删原型 一条 + 只有 route_key 的无效链接 一条 + 软删项目下原型 一条。
      last7d: 8,
      // 日历日 -8 的两条：在 14 天趋势窗内、在近 7 天窗外 → 只做环比分母。
      previous7d: 2,
      today: 8,
      // 去重键 (本地日, ip, ua)：同 ip 同 ua 的两条 → 1；换 ip → 2；P1草稿 → 3；
      // 软删原型 → 4；无效链接 → 5；软删项目下原型 → 6；bot 不计。
      uvLast7d: 6,
    });
  });

  it('与 §6.2 汇总页同一条尺子：同一时刻两条入口的 pv/uv/被拒完全相等', async () => {
    // 判据"工作台点开访问记录页要看得懂同一批行"的直接落点：两条入口共用 `resolveScope`
    // 与同一把日历日窗口，数字不许因为走了另一条 SQL 而漂移。
    const { visitStats } = await dashboard.overview(userA);
    const summary = await accessLogs.summary(userA, {
      days: ACCESS_LOG_SUMMARY_DEFAULT_DAYS,
    });

    expect(summary.pv).toBe(visitStats.last7d);
    expect(summary.uv).toBe(visitStats.uvLast7d);
    expect(summary.denied).toBe(visitStats.deniedLast7d);
  });

  it('B 的 visitStats 只剩他自己那一条，A 的八条不污染过去', async () => {
    expect(await dashboard.overview(userB)).toMatchObject({
      projectStats: { archived: 0, draft: 0, published: 1, total: 1 },
      prototypeStats: { archived: 0, draft: 0, published: 1, total: 1 },
      releaseStats: { thisWeek: 1, today: 1 },
      visitStats: { deniedLast7d: 0, last7d: 1, previous7d: 0, today: 1, uvLast7d: 1 },
    });
    expect((await dashboard.overview(userB)).recentPrototypes.map((row) => row.code)).toEqual([
      PROTO_CODE.b,
    ]);
  });
});

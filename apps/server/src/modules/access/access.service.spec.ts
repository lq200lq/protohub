import { describe, expect, it, vi, type Mock } from 'vitest';
import { USER_STATUS_ENABLED } from '@protohub/shared';

import type { Account } from '../../common/permission/account.service';
import type { AccountService } from '../../common/permission/account.service';
import { accessCookieName, SESSION_COOKIE_NAME } from '../../common/permission/cookie.service';
import { SessionService } from '../../common/permission/session.service';
import type { ProjectRepo } from '../project/project.repo';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import type { AccessRepo, AccessRows } from './access.repo';
import { AccessService, type AccessQuery } from './access.service';
import type { AccessProjectRow, AccessPrototypeRow } from './decide-access';
import type { AccessPrototypeInfo } from './access.repo';
import { UnlockTokenService } from './unlock-token.service';

/**
 * AccessService 单测（计划 M4-T2；机制 §5.1/§5.4、接口设计 §9.1）。
 *
 * 桩只打在**查库**那一侧（`AccessRepo` / `AccountService` / `ProjectRepo`）；
 * `SessionService` 与 `UnlockTokenService` 用真实例——它们是本服务唯一的密钥逻辑，
 * 桩掉就只剩"传参对不对"，验不到"改密后旧 Cookie 立刻失效"这类真行为。
 *
 * 除判定结果外，这里还钉一条性能契约（机制 §7.1：这个接口在原型每个子资源请求上都会被调一次）：
 * public 档与被拒定案（404/归档/未发布）**不读 Cookie、不查用户表、不查项目范围**。
 */

const sessions = new SessionService(fakeAppEnv({ NODE_ENV: 'test' }));
const unlockTokens = new UnlockTokenService(fakeAppEnv({ NODE_ENV: 'test' }));

const PROJECT_ID = '9';
const PROTOTYPE_ID = '31';

function projectRow(overrides: Partial<AccessProjectRow> = {}): AccessProjectRow {
  return { archivedAt: null, deletedAt: null, id: PROJECT_ID, ...overrides };
}

function prototypeRow(overrides: Partial<AccessPrototypeInfo> = {}): AccessPrototypeInfo {
  return {
    accessMode: 'public',
    currentReleaseId: '77',
    deletedAt: null,
    id: PROTOTYPE_ID,
    policyVersion: 3,
    status: 'published',
    ...overrides,
  };
}

/** `null` 表示"这一层的行查不到"，对象表示按覆盖值存活。 */
function rowsWith(input: {
  readonly project?: AccessProjectRow | null;
  readonly prototype?: AccessPrototypeInfo | null;
} = {}): AccessRows {
  return {
    // 刻意不用 `??`：显式传 null 就是"这一层的行查不到"，与"没传"必须区分开
    project: input.project === undefined ? projectRow() : input.project,
    prototype: input.prototype === undefined ? prototypeRow() : input.prototype,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    userId: '42',
    username: 'lisi',
    realName: '李四',
    avatar: null,
    email: null,
    phone: null,
    status: USER_STATUS_ENABLED,
    tokenVersion: 0,
    forcePasswordChange: false,
    roles: [],
    dataScope: 'member',
    superAdmin: false,
    ...overrides,
  };
}

interface Harness {
  readonly accounts: { loadById: ReturnType<typeof vi.fn> };
  readonly projects: { findInScope: ReturnType<typeof vi.fn> };
  readonly readCookie: Mock<(name: string) => string | undefined>;
  readonly repo: { findRowsByCodes: ReturnType<typeof vi.fn> };
  readonly service: AccessService;
}

function harness(rows: AccessRows, cookies: Record<string, string> = {}): Harness {
  const repo = { findRowsByCodes: vi.fn().mockResolvedValue(rows) };
  const accounts = { loadById: vi.fn().mockResolvedValue(account()) };
  const projects = { findInScope: vi.fn().mockResolvedValue({ id: BigInt(PROJECT_ID) }) };
  const readCookie = vi.fn((name: string): string | undefined => cookies[name]);
  const service = new AccessService(
    repo as unknown as AccessRepo,
    projects as unknown as ProjectRepo,
    accounts as unknown as AccountService,
    sessions,
    unlockTokens,
  );
  return { accounts, projects, readCookie, repo, service };
}

function query(readCookie: AccessQuery['readCookie']): AccessQuery {
  return { projectCode: 'crm', prototypeCode: 'crm-p01', readCookie };
}

describe('AccessService：按编码取行 + 按需算凭据', () => {
  it('一次查询按两段编码取行（不做联表统计，接口设计 §9.1）', async () => {
    const h = harness(rowsWith());
    await h.service.decide(query(h.readCookie));
    expect(h.repo.findRowsByCodes).toHaveBeenCalledWith('crm', 'crm-p01');
    expect(h.repo.findRowsByCodes).toHaveBeenCalledTimes(1);
  });

  it('public 档放行，且不读任何 Cookie、不查用户表与项目范围', async () => {
    const h = harness(rowsWith());
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ releaseId: '77', status: 200 });
    expect(h.readCookie).not.toHaveBeenCalled();
    expect(h.accounts.loadById).not.toHaveBeenCalled();
    expect(h.projects.findInScope).not.toHaveBeenCalled();
    expect(outcome.projectId).toBe(PROJECT_ID);
    expect(outcome.prototypeId).toBe(PROTOTYPE_ID);
  });

  it('编码查不到行 → 404 NOT_FOUND，同样不碰凭据（不给枚举编码留信息）', async () => {
    const h = harness(rowsWith({ project: null, prototype: null }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NOT_FOUND', status: 404 });
    expect(outcome.projectId).toBeNull();
    expect(outcome.prototypeId).toBeNull();
    expect(h.readCookie).not.toHaveBeenCalled();
    expect(h.accounts.loadById).not.toHaveBeenCalled();
  });

  it('项目归档 → 403 PROJECT_ARCHIVED，成员档也不再去看登录态（结论与身份无关）', async () => {
    const h = harness(rowsWith({
      project: projectRow({ archivedAt: new Date('2026-10-01T00:00:00Z') }),
      prototype: prototypeRow({ accessMode: 'member' }),
    }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'PROJECT_ARCHIVED', status: 403 });
    expect(h.readCookie).not.toHaveBeenCalled();
  });

  it('原型是 draft → 404 NOT_PUBLISHED（与"编码不存在"同一个状态码）', async () => {
    const h = harness(rowsWith({ prototype: prototypeRow({ currentReleaseId: null, status: 'draft' }) }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NOT_PUBLISHED', status: 404 });
    expect(h.readCookie).not.toHaveBeenCalled();
  });
});

describe('password 档：只验解锁 Cookie，不查登录态', () => {
  const passwordRows = () => rowsWith({ prototype: prototypeRow({ accessMode: 'password' }) });

  it('没有解锁 Cookie → 401 NEED_PASSWORD，读的是 proto_access_p{原型ID}', async () => {
    const h = harness(passwordRows());
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
    expect(h.readCookie).toHaveBeenCalledWith(accessCookieName(PROTOTYPE_ID));
    expect(h.accounts.loadById).not.toHaveBeenCalled();
  });

  it('正确令牌 → 200 并带出 releaseId', async () => {
    const token = unlockTokens.issue({
      policyVersion: 3,
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
    });
    const h = harness(passwordRows(), { [accessCookieName(PROTOTYPE_ID)]: token });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ releaseId: '77', status: 200 });
  });

  it('改密码/改访问模式后 policy_version 前进，旧令牌立刻失效（决策 D-07）', async () => {
    const token = unlockTokens.issue({
      policyVersion: 2,
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
    });
    const h = harness(passwordRows(), { [accessCookieName(PROTOTYPE_ID)]: token });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
  });

  it('把别的原型的解锁 Cookie 挪过来不生效（签名绑定两级编码）', async () => {
    const token = unlockTokens.issue({
      policyVersion: 3,
      projectCode: 'crm',
      prototypeCode: 'crm-p02',
    });
    const h = harness(passwordRows(), { [accessCookieName(PROTOTYPE_ID)]: token });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
  });

  it('带着有效 proto_sess 也不放行，而且根本不读它（member 身份不给密码档让路）', async () => {
    const h = harness(passwordRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 0) });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
    expect(h.readCookie).not.toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(h.accounts.loadById).not.toHaveBeenCalled();
  });
});

describe('member 档：proto_sess + token_version + 项目数据范围', () => {
  const memberRows = () => rowsWith({ prototype: prototypeRow({ accessMode: 'member' }) });

  it('没有 proto_sess → 403 NEED_LOGIN，并且不查用户表', async () => {
    const h = harness(memberRows());
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
    expect(h.readCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(h.accounts.loadById).not.toHaveBeenCalled();
    expect(h.projects.findInScope).not.toHaveBeenCalled();
  });

  it('会话有效且项目在他范围内 → 200，访问者 id 带出去写日志', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 0) });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ releaseId: '77', status: 200 });
    expect(outcome.sessionUserId).toBe('42');
    expect(h.accounts.loadById).toHaveBeenCalledWith('42');
    // 范围判定复用 M2 那一份 projectScopeWhere：id 是 BigInt、范围取自用户最宽的角色
    expect(h.projects.findInScope).toHaveBeenCalledWith(9n, {
      dataScope: 'member',
      userId: 42n,
    });
  });

  it('登录了但项目不在范围内 → 403 NO_PERMISSION（不是 NEED_LOGIN），id 仍然记下', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 0) });
    h.projects.findInScope.mockResolvedValue(null);
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NO_PERMISSION', status: 403 });
    expect(outcome.sessionUserId).toBe('42');
  });

  it('改密后 token_version 对不上 → 当作未登录，且不再查项目范围', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 1) });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
    expect(outcome.sessionUserId).toBeNull();
    expect(h.projects.findInScope).not.toHaveBeenCalled();
  });

  it('账号被停用 → NEED_LOGIN（停用与"从没登录"同一个出口）', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 0) });
    h.accounts.loadById.mockResolvedValue(account({ status: 0 }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
    expect(h.projects.findInScope).not.toHaveBeenCalled();
  });

  it('用户行已不存在（被删） → NEED_LOGIN', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('42', 0) });
    h.accounts.loadById.mockResolvedValue(null);
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
  });

  it('伪造/被篡改的 proto_sess → NEED_LOGIN（真实验签，不给"把自己塞成成员"留缝）', async () => {
    const forged = `${sessions.issue('42', 0).split('.').slice(0, 4).join('.')}.notaseal`;
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: forged });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
    expect(h.accounts.loadById).not.toHaveBeenCalled();
  });

  it('超管（dataScope=all）无需成员关系即可访问 member 档', async () => {
    const h = harness(memberRows(), { [SESSION_COOKIE_NAME]: sessions.issue('1', 0) });
    h.accounts.loadById.mockResolvedValue(account({ dataScope: 'all', userId: '1' }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ releaseId: '77', status: 200 });
    expect(h.projects.findInScope).toHaveBeenCalledWith(9n, {
      dataScope: 'all',
      userId: 1n,
    });
  });

  it('解锁 Cookie 不参与 member 档判定（两档各查各的，不多读一次 Cookie）', async () => {
    const h = harness(memberRows(), { [accessCookieName(PROTOTYPE_ID)]: 'v1.3.9999999999.sig' });
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_LOGIN', status: 403 });
    expect(h.readCookie).not.toHaveBeenCalledWith(accessCookieName(PROTOTYPE_ID));
  });
});

describe('软删与状态兜底', () => {
  it('库里读到联合之外的 access_mode 时按最严处理：要密码而不是公开', async () => {
    const rows = rowsWith({
      prototype: prototypeRow({
        // 模拟 varchar 列里的越界值（CHECK 之外的历史脏数据）
        accessMode: 'annonymous' as AccessPrototypeRow['accessMode'],
      }),
    });
    const h = harness(rows);
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
  });

  it('原型行软删 → 404（查询层已过滤，这里守住"死行绝不放行"）', async () => {
    const h = harness(rowsWith({ prototype: null }));
    const outcome = await h.service.decide(query(h.readCookie));
    expect(outcome.decision).toEqual({ reason: 'NOT_FOUND', status: 404 });
  });
});

import { describe, expect, it } from 'vitest';

import {
  decideAccess,
  type AccessPrototypeRow,
  type AccessProjectRow,
} from './decide-access';

/**
 * M4-T1 的穷举单测（迭代实施计划 §5 M4 判据：覆盖 3 档 × 4 种状态 × 有/无 cookie 的全部组合）。
 *
 * 这份测试是**先写的**：判据要求先有穷举再谈实现，因为 decideAccess 是生产放行（nginx
 * auth_request）与本地直出（SERVE_STATIC=node）唯一的口径，它错一格就是"该拦的放过去"
 * 或"该看的看不见"，而两种症状在界面上都只表现为"链接时好时坏"。
 *
 * 期望值全部按 [原型发布与访问机制.md](../../../../docs/原型发布与访问机制.md) §5.1 的
 * ①②③④ 四条前置检查 + access_mode 分支手写在每个用例上，不从被测函数推导。
 */

const PROJECT: AccessProjectRow = {
  archivedAt: null,
  deletedAt: null,
  id: '9',
};

const PUBLISHED: AccessPrototypeRow = {
  accessMode: 'public',
  currentReleaseId: '77',
  deletedAt: null,
  id: '31',
  status: 'published',
};

/** 只覆盖"项目存在且未归档 + 原型存在"这条主干之外的轴，减少每个用例要写的字段。 */
function input(overrides: {
  readonly project?: AccessProjectRow | null;
  readonly prototype?: AccessPrototypeRow | null;
  readonly unlocked?: boolean;
  readonly sessionUserId?: string | null;
  readonly projectVisible?: boolean;
}) {
  return {
    project: overrides.project === undefined ? PROJECT : overrides.project,
    projectVisible: overrides.projectVisible ?? false,
    prototype: overrides.prototype === undefined ? PUBLISHED : overrides.prototype,
    sessionUserId: overrides.sessionUserId === undefined ? null : overrides.sessionUserId,
    unlocked: overrides.unlocked ?? false,
  };
}

function prototypeOf(
  overrides: Partial<AccessPrototypeRow> = {},
): AccessPrototypeRow {
  return { ...PUBLISHED, ...overrides };
}

describe('decideAccess ① 存在性：统一 404，不区分"不存在"与"未发布"（R-9 防编码枚举）', () => {
  it('项目行查不到 → 404 NOT_FOUND', () => {
    expect(decideAccess(input({ project: null }))).toEqual({
      reason: 'NOT_FOUND',
      status: 404,
    });
  });

  it('原型行查不到 → 404 NOT_FOUND', () => {
    expect(decideAccess(input({ prototype: null }))).toEqual({
      reason: 'NOT_FOUND',
      status: 404,
    });
  });

  it('项目软删除 → 404（不是 403：删除与不存在对外的形状必须一致）', () => {
    expect(
      decideAccess(
        input({ project: { ...PROJECT, deletedAt: new Date(0) } }),
      ),
    ).toEqual({ reason: 'NOT_FOUND', status: 404 });
  });

  it('原型软删除 → 404，即使带着有效解锁 Cookie 也不放行', () => {
    expect(
      decideAccess(
        input({
          prototype: prototypeOf({ deletedAt: new Date(0) }),
          unlocked: true,
        }),
      ),
    ).toEqual({ reason: 'NOT_FOUND', status: 404 });
  });

  it('原型不存在时，四种凭据形态（含有效解锁 Cookie 与可见成员身份）得到的都是同一个 404', () => {
    for (const ctx of [
      {},
      { unlocked: true },
      { projectVisible: true, sessionUserId: '5' },
      { projectVisible: false, sessionUserId: '5' },
    ]) {
      expect(decideAccess(input({ ...ctx, prototype: null }))).toEqual({
        reason: 'NOT_FOUND',
        status: 404,
      });
    }
  });
});

describe('decideAccess ②③④ 前置状态：归档 → 403，未发布 → 404，且顺序不能反', () => {
  it('项目归档 → 403 PROJECT_ARCHIVED，三档都拦（归档压过一切访问模式）', () => {
    for (const mode of ['member', 'password', 'public'] as const) {
      expect(
        decideAccess(
          input({
            project: { ...PROJECT, archivedAt: new Date(0) },
            prototype: prototypeOf({ accessMode: mode }),
          }),
        ),
      ).toEqual({ reason: 'PROJECT_ARCHIVED', status: 403 });
    }
  });

  it('项目归档 + 原型也归档 → PROJECT_ARCHIVED（②在③前，给门面页的是项目那一句）', () => {
    expect(
      decideAccess(
        input({
          project: { ...PROJECT, archivedAt: new Date(0) },
          prototype: prototypeOf({ status: 'archived' }),
        }),
      ),
    ).toEqual({ reason: 'PROJECT_ARCHIVED', status: 403 });
  });

  it('项目归档 + 未发布 → 仍是 403 PROJECT_ARCHIVED（下架的原因归到项目层）', () => {
    expect(
      decideAccess(
        input({
          project: { ...PROJECT, archivedAt: new Date(0) },
          prototype: prototypeOf({ currentReleaseId: null, status: 'draft' }),
        }),
      ),
    ).toEqual({ reason: 'PROJECT_ARCHIVED', status: 403 });
  });

  it('原型归档 → 403 PROTOTYPE_ARCHIVED，三档都拦，且解锁 Cookie 与登录态都不能绕过', () => {
    for (const mode of ['member', 'password', 'public'] as const) {
      expect(
        decideAccess(
          input({
            projectVisible: true,
            prototype: prototypeOf({ accessMode: mode, status: 'archived' }),
            sessionUserId: '5',
            unlocked: true,
          }),
        ),
      ).toEqual({ reason: 'PROTOTYPE_ARCHIVED', status: 403 });
    }
  });

  it('archived 的原型即使还挂着 current_release_id 也是 403（指针不是放行条件）', () => {
    expect(
      decideAccess(
        input({ prototype: prototypeOf({ status: 'archived' }) }),
      ),
    ).toEqual({ reason: 'PROTOTYPE_ARCHIVED', status: 403 });
  });

  it('status=draft（从没发布过）→ 404 NOT_PUBLISHED，三档一致', () => {
    for (const mode of ['member', 'password', 'public'] as const) {
      expect(
        decideAccess(
          input({
            projectVisible: true,
            prototype: prototypeOf({
              accessMode: mode,
              currentReleaseId: null,
              status: 'draft',
            }),
            sessionUserId: '5',
            unlocked: true,
          }),
        ),
      ).toEqual({ reason: 'NOT_PUBLISHED', status: 404 });
    }
  });

  it('published 但指针为空（版本被删/数据不一致）→ 404 NOT_PUBLISHED，不给 nginx 空目录', () => {
    expect(
      decideAccess(
        input({ prototype: prototypeOf({ currentReleaseId: null }) }),
      ),
    ).toEqual({ reason: 'NOT_PUBLISHED', status: 404 });
  });
});

describe('decideAccess ⑤ access_mode=public：唯一"什么都不看"的一档', () => {
  it('公开档 200 + releaseId，不看解锁 Cookie 也不看登录态', () => {
    expect(decideAccess(input({ prototype: prototypeOf({ accessMode: 'public' }) }))).toEqual({
      releaseId: '77',
      status: 200,
    });
  });

  it('公开档即使项目不可见（非成员）也放行——可见性只约束 member 档', () => {
    expect(
      decideAccess(
        input({
          projectVisible: false,
          prototype: prototypeOf({ accessMode: 'public' }),
          sessionUserId: '5',
        }),
      ),
    ).toEqual({ releaseId: '77', status: 200 });
  });
});

describe('decideAccess ⑤ access_mode=password：401 只表示"需要访问密码"', () => {
  it('解锁 Cookie 验签通过 → 200', () => {
    expect(
      decideAccess(
        input({
          prototype: prototypeOf({ accessMode: 'password' }),
          unlocked: true,
        }),
      ),
    ).toEqual({ releaseId: '77', status: 200 });
  });

  it('没有 / 验签不过的 Cookie → 401 NEED_PASSWORD（不带 releaseId，不能泄露目录）', () => {
    const denied = decideAccess(
      input({
        prototype: prototypeOf({ accessMode: 'password' }),
        unlocked: false,
      }),
    );
    expect(denied).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
    expect(denied).not.toHaveProperty('releaseId');
  });

  it('密码档不因"是项目成员"而放行（档位之间不叠加权限）', () => {
    expect(
      decideAccess(
        input({
          projectVisible: true,
          prototype: prototypeOf({ accessMode: 'password' }),
          sessionUserId: '5',
        }),
      ),
    ).toEqual({ reason: 'NEED_PASSWORD', status: 401 });
  });
});

describe('decideAccess ⑤ access_mode=member：只用 Cookie 认身份（机制 §5.4）', () => {
  it('未登录 → 403 NEED_LOGIN（403 而不是 401：401 已被"需要访问密码"占用）', () => {
    expect(
      decideAccess(
        input({
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: null,
        }),
      ),
    ).toEqual({ reason: 'NEED_LOGIN', status: 403 });
  });

  it('已登录但项目不可见 → 403 NO_PERMISSION', () => {
    expect(
      decideAccess(
        input({
          projectVisible: false,
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: '5',
        }),
      ),
    ).toEqual({ reason: 'NO_PERMISSION', status: 403 });
  });

  it('已登录且项目可见 → 200（范围停在项目层：能看到项目就能看到它下面所有原型）', () => {
    expect(
      decideAccess(
        input({
          projectVisible: true,
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: '5',
        }),
      ),
    ).toEqual({ releaseId: '77', status: 200 });
  });

  it('成员档不认解锁 Cookie：拿着别的原型签发的 proto_access_* 也进不来', () => {
    expect(
      decideAccess(
        input({
          projectVisible: true,
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: '5',
          unlocked: false,
        }),
      ).status,
    ).toBe(200);
    // 未登录 + unlocked=true（把密码档的令牌挪过来）依然拦：两条通道不互换
    expect(
      decideAccess(
        input({
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: null,
          unlocked: true,
        }),
      ),
    ).toEqual({ reason: 'NEED_LOGIN', status: 403 });
  });

  it('projectVisible 在没有登录态时不参与判定（调用方漏算也不影响结果）', () => {
    expect(
      decideAccess(
        input({
          projectVisible: true,
          prototype: prototypeOf({ accessMode: 'member' }),
          sessionUserId: null,
        }),
      ),
    ).toEqual({ reason: 'NEED_LOGIN', status: 403 });
  });
});

describe('decideAccess 的组合覆盖（M4 回写项要的读数：状态码语义不许漂）', () => {
  const modes = ['member', 'password', 'public'] as const;
  const prototypeStates = [
    { key: 'archived', row: prototypeOf({ status: 'archived' }) },
    {
      key: 'draft',
      row: prototypeOf({ currentReleaseId: null, status: 'draft' }),
    },
    { key: 'published', row: prototypeOf() },
    {
      key: 'published-without-pointer',
      row: prototypeOf({ currentReleaseId: null }),
    },
    { key: 'deleted', row: prototypeOf({ deletedAt: new Date(0) }) },
    { key: 'missing', row: null },
  ] as const;
  const projectStates = [
    { key: 'active', row: PROJECT },
    { key: 'archived', row: { ...PROJECT, archivedAt: new Date(0) } },
    { key: 'deleted', row: { ...PROJECT, deletedAt: new Date(0) } },
    { key: 'missing', row: null },
  ] as const;
  const credentials = [
    { key: 'anonymous', ctx: {} },
    { key: 'unlocked', ctx: { unlocked: true } },
    { key: 'member-visible', ctx: { projectVisible: true, sessionUserId: '5' } },
    { key: 'member-invisible', ctx: { projectVisible: false, sessionUserId: '5' } },
    { key: 'both', ctx: { projectVisible: true, sessionUserId: '5', unlocked: true } },
  ] as const;

  let combos = 0;
  const statusCounts = new Map<string, number>();

  for (const mode of modes) {
    for (const projectState of projectStates) {
      for (const prototypeState of prototypeStates) {
        for (const credential of credentials) {
          combos += 1;
          const decision = decideAccess(
            input({
              ...credential.ctx,
              project: projectState.row,
              prototype:
                prototypeState.row === null
                  ? null
                  : { ...prototypeState.row, accessMode: mode },
            }),
          );
          const label = `${mode}/${projectState.key}/${prototypeState.key}/${credential.key}=${decision.status}${decision.reason ? `/${decision.reason}` : ''}`;
          statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);

          // 不变式 1：非 200 一律没有 releaseId（否则 nginx 会拿着目录去服务被拒的请求）
          if (decision.status !== 200) {
            expect(decision, label).not.toHaveProperty('releaseId');
            expect(decision.reason, label).toBeTruthy();
          }
          // 不变式 2：200 必须带 releaseId
          if (decision.status === 200) {
            expect(decision.releaseId, label).toBe('77');
            expect(decision.reason, label).toBeUndefined();
          }
          // 不变式 3：401 只在 password 档出现；404 只表示不存在/未发布
          if (decision.status === 401) {
            expect(mode, label).toBe('password');
          }
          // 不变式 4：状态码与 reason 的配对是封闭的（接口设计 §9.1 的头表）
          if (decision.status === 403) {
            expect(
              ['NEED_LOGIN', 'NO_PERMISSION', 'PROJECT_ARCHIVED', 'PROTOTYPE_ARCHIVED'],
              label,
            ).toContain(decision.reason);
          }
          if (decision.status === 404) {
            expect(['NOT_FOUND', 'NOT_PUBLISHED'], label).toContain(decision.reason);
          }
        }
      }
    }
  }

  it('组合数 = 3 档 × 4 项目状态 × 6 原型状态 × 5 凭据形态', () => {
    expect(combos).toBe(3 * 4 * 6 * 5);
    // 穷举跑完没有把任何一组甩出上面四条不变式之外
    expect(statusCounts.size).toBeGreaterThan(0);
  });

  it('归档/未发布/不存在的判定优先于访问模式：同一条主干上换三档得到同一个结果', () => {
    const blocked = prototypeStates.filter((s) => s.key !== 'published');
    for (const projectState of projectStates.filter((s) => s.key !== 'active')) {
      for (const prototypeState of blocked) {
        const results = modes.map((mode) =>
          decideAccess(
            input({
              project: projectState.row,
              prototype:
                prototypeState.row === null
                  ? null
                  : { ...prototypeState.row, accessMode: mode },
              unlocked: true,
              projectVisible: true,
              sessionUserId: '5',
            }),
          ),
        );
        expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      }
    }
  });
});

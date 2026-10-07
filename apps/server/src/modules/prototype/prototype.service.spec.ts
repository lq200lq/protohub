import { describe, expect, it, vi } from 'vitest';

import type { Actor, RequestMeta } from '../system/common/actor';
import type { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import type { AppEnvService } from '../../config/app-env.service';
import type { ProjectRepo, ProjectRow } from '../project/project.repo';
import { BusinessException } from '../../common/exception/business.exception';
import { PrototypeRepo, type PrototypeAggregates, type PrototypeRow } from './prototype.repo';
import { PrototypeService } from './prototype.service';

/**
 * PrototypeService 单测（计划 M2-T3/M2-T11；接口设计 §4.3/§4.4；决策 D-07/D-20/D-21）。
 * Repo 全部用 vi.fn 桩（同 role.service.spec.ts）：钉的是"取号/重试/策略版本/审计脱敏"这些
 * 服务层规则，而不是 Prisma 本身。argon2 也被桩掉——密码哈希的真实实现另有测试覆盖。
 */

vi.mock('argon2', () => ({
  argon2id: 2,
  hash: vi.fn(async (password: string) => `$argon2id stub ${password.length}`),
}));

const ACTOR: Actor = {
  userId: '3',
  username: 'gateadmin',
  roles: ['admin'],
  isSuperAdmin: false,
  dataScope: 'all',
};
const REQUEST: RequestMeta = { method: 'POST', path: '/api/prototypes', ip: '127.0.0.1' };
const EMPTY_PAGE = { page: 1, pageSize: 20, skip: 0 };

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    archivedAt: null,
    code: 'crm',
    createdAt: new Date('2026-10-06T09:00:00Z'),
    createdBy: 3n,
    createdByName: '张三',
    description: null,
    id: 9n,
    name: 'CRM系统',
    updatedAt: new Date('2026-10-06T10:00:00Z'),
    ...overrides,
  };
}

function prototypeRow(overrides: Partial<PrototypeRow> = {}): PrototypeRow {
  return {
    accessMode: 'public',
    archivedAt: null,
    code: 'crm-p01',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    createdBy: 3n,
    currentReleaseId: null,
    description: null,
    firstPublishedAt: null,
    hasAccessPassword: false,
    id: 31n,
    name: '登录页演示',
    policyVersion: 1,
    projectCode: 'crm',
    projectId: 9n,
    publishedAt: null,
    sort: 0,
    status: 'draft',
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

const NO_AGGREGATES: PrototypeAggregates = {
  currentRelease: null,
  releaseCount: 0,
  visitsLast7d: 0,
};

/** 桩只声明服务真正调用到的方法；构造服务时用 `as unknown as` 收敛（同 role.service.spec.ts）。 */
interface Harness {
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly projects: {
    findAccessible: ReturnType<typeof vi.fn>;
    members: ReturnType<typeof vi.fn>;
  };
  readonly repo: {
    activeCodesInProject: ReturnType<typeof vi.fn>;
    aggregatesFor: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findAccessible: ReturnType<typeof vi.fn>;
    findActiveByCode: ReturnType<typeof vi.fn>;
    findPaged: ReturnType<typeof vi.fn>;
    isCodeConflict: ReturnType<typeof vi.fn>;
    setPolicy: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    softDelete: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  readonly service: PrototypeService;
}

function createHarness(row: PrototypeRow = prototypeRow()): Harness {
  const repo = {
    activeCodesInProject: vi.fn().mockResolvedValue([]),
    aggregatesFor: vi.fn().mockResolvedValue(new Map([[String(row.id), NO_AGGREGATES]])),
    create: vi.fn().mockResolvedValue(row.id),
    findAccessible: vi.fn().mockResolvedValue(row),
    findActiveByCode: vi.fn().mockResolvedValue(null),
    findPaged: vi.fn().mockResolvedValue({ aggregates: new Map(), rows: [], total: 0 }),
    isCodeConflict: vi.fn((error: unknown) => (error as { code?: string })?.code === 'P2002'),
    setPolicy: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
  };
  const projects = {
    findAccessible: vi.fn().mockResolvedValue(projectRow()),
    members: vi.fn().mockResolvedValue([{ user: { id: 3n } }]),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const appEnv = { env: { http: { publicBaseUrl: 'https://proto.example.com' } } };
  const service = new PrototypeService(
    repo as unknown as PrototypeRepo,
    projects as unknown as ProjectRepo,
    audit as unknown as OperationAuditWriter,
    appEnv as unknown as AppEnvService,
  );
  return { audit, projects, repo, service };
}

function conflict(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

describe('原型编码自动生成（D-20：{项目码}-pNN，项目内递增）', () => {
  it('留空时取项目内已有生成码的最大序号 +1', async () => {
    const h = createHarness();
    h.repo.activeCodesInProject.mockResolvedValue(['crm-p01', 'crm-p03', 'checkout-flow']);
    await h.service.create(ACTOR, { projectId: '9', name: '新原型' }, REQUEST);
    expect(h.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'crm-p04', projectId: 9n }),
    );
  });

  it('跨越 p99 进位成三位（p100），不是回绕成 p00', async () => {
    const h = createHarness();
    h.repo.activeCodesInProject.mockResolvedValue(['crm-p98', 'crm-p99']);
    await h.service.create(ACTOR, { projectId: '9', name: '第 100 个' }, REQUEST);
    expect(h.repo.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'crm-p100' }));
  });

  it('撞唯一索引时重新读一遍编码再试，成功后不再重试', async () => {
    const h = createHarness();
    h.repo.activeCodesInProject
      .mockResolvedValueOnce(['crm-p01'])
      .mockResolvedValueOnce(['crm-p01', 'crm-p02']);
    h.repo.create.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(32n);
    await h.service.create(ACTOR, { projectId: '9', name: '并发新建' }, REQUEST);
    // 第二次取号基于"含被抢走的 p02"的新快照，所以拿到 p03。
    expect(h.repo.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ code: 'crm-p03' }),
    );
    expect(h.repo.create).toHaveBeenCalledTimes(2);
  });

  it('连续冲突到上限后抛 409，而不是无限重试', async () => {
    const h = createHarness();
    h.repo.create.mockRejectedValue(conflict());
    await expect(
      h.service.create(ACTOR, { projectId: '9', name: '一直撞码' }, REQUEST),
    ).rejects.toMatchObject({ errorCode: 'PROTO_SLUG_DUPLICATED', httpStatus: 409 });
    expect(h.repo.create).toHaveBeenCalledTimes(5);
  });

  it('非撞码的唯一约束（别的 P2002）直接上抛，不消耗重试次数', async () => {
    const h = createHarness();
    h.repo.isCodeConflict.mockReturnValue(false);
    h.repo.create.mockRejectedValue(conflict());
    await expect(
      h.service.create(ACTOR, { projectId: '9', name: '别的约束' }, REQUEST),
    ).rejects.toThrow('Unique constraint failed');
    expect(h.repo.create).toHaveBeenCalledTimes(1);
  });
});

describe('手填编码（G3/G4）', () => {
  it('项目内已占用 → 400，提示里带上占用者的名字', async () => {
    const h = createHarness();
    h.repo.findActiveByCode.mockResolvedValue(prototypeRow({ id: 31n, name: '登录页演示' }));
    const error = await h.service
      .create(ACTOR, { code: 'crm-p01', name: '重名', projectId: '9' }, REQUEST)
      .catch((e: unknown) => e as BusinessException);
    expect(error).toBeInstanceOf(BusinessException);
    expect(error).toMatchObject({ errorCode: 'PROTO_SLUG_DUPLICATED' });
    expect((error as BusinessException).message).toContain('登录页演示');
    expect(h.repo.create).not.toHaveBeenCalled();
  });

  it('格式不合法 → 400 PROTO_CODE_INVALID，消息说清规则', async () => {
    const h = createHarness();
    const error = await h.service
      .create(ACTOR, { code: '-Bad_Code-', name: '非法', projectId: '9' }, REQUEST)
      .catch((e: unknown) => e as BusinessException);
    expect(error).toMatchObject({ errorCode: 'PROTO_CODE_INVALID' });
    expect((error as BusinessException).message).toContain('小写字母');
  });

  it('合法手填码原样落库，访问地址随之变成 /p/{项目码}/{手填码}', async () => {
    const h = createHarness(prototypeRow({ code: 'checkout-flow' }));
    const detail = await h.service.create(
      ACTOR,
      { code: 'checkout-flow', name: '结算流程', projectId: '9' },
      REQUEST,
    );
    expect(h.repo.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'checkout-flow' }));
    expect(detail.accessPath).toBe('/p/crm/checkout-flow');
    expect(detail.accessUrl).toBe('https://proto.example.com/p/crm/checkout-flow');
  });
});

describe('check-code（§4.3.2）', () => {
  it('留空返回"留空将生成这个"', async () => {
    const h = createHarness();
    h.repo.activeCodesInProject.mockResolvedValue(['crm-p01']);
    expect(await h.service.checkCode(ACTOR, '9')).toEqual({
      available: true,
      generated: 'crm-p02',
    });
  });

  it('被占用时给可读原因和一个项目内没被占用的备选码', async () => {
    const h = createHarness();
    h.repo.findActiveByCode.mockImplementation(async (_id: bigint, code: string) =>
      code === 'crm-p01' ? prototypeRow({ code: 'crm-p01', name: '登录页演示' }) : null,
    );
    const result = await h.service.checkCode(ACTOR, '9', 'crm-p01');
    expect(result).toMatchObject({
      available: false,
      reason: 'CODE_TAKEN',
      suggestion: 'crm-p01-2',
    });
    expect(result.message).toContain('已被原型「登录页演示」占用');
  });

  it('原型码不查保留字（挂在 /p/ 之下，不与一级路由冲突）', async () => {
    const h = createHarness();
    expect(await h.service.checkCode(ACTOR, '9', 'api')).toEqual({ available: true });
  });
});

describe('访问策略（§4.4 + D-07/D-21）', () => {
  it('密码档既没给新密码又没有旧密码 → 400 PROTO_POLICY_PASSWORD_REQUIRED', async () => {
    const h = createHarness();
    await expect(
      h.service.setPolicy(ACTOR, '31', { accessMode: 'password' }, REQUEST),
    ).rejects.toMatchObject({ errorCode: 'PROTO_POLICY_PASSWORD_REQUIRED' });
    expect(h.repo.setPolicy).not.toHaveBeenCalled();
  });

  it('密码不足 6 位 → 400，且不落任何哈希', async () => {
    const h = createHarness();
    await expect(
      h.service.setPolicy(ACTOR, '31', { accessMode: 'password', password: '12345' }, REQUEST),
    ).rejects.toMatchObject({ errorCode: 'PROTO_POLICY_PASSWORD_INVALID' });
    expect(h.repo.setPolicy).not.toHaveBeenCalled();
  });

  it('改模式 + 设密码：policy_version +1，审计只记 password_changed，绝不出现密码', async () => {
    const h = createHarness();
    await h.service.setPolicy(
      ACTOR,
      '31',
      { accessMode: 'password', password: 'gate-pass-1' },
      REQUEST,
    );
    expect(h.repo.setPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ accessMode: 'password', policyVersion: 2 }),
    );
    const detail = h.audit.record.mock.calls[0]?.[0] as { detail: Record<string, unknown> };
    expect(detail.detail).toEqual({
      after: { accessMode: 'password' },
      before: { accessMode: 'public' },
      password_changed: true,
    });
    expect(JSON.stringify(detail.detail)).not.toContain('gate-pass-1');
  });

  it('模式没变也没换密码：不写库、不加 policy_version（旧解锁 Cookie 不该被无谓作废）', async () => {
    const h = createHarness(prototypeRow({ accessMode: 'password', hasAccessPassword: true }));
    await h.service.setPolicy(ACTOR, '31', { accessMode: 'password' }, REQUEST);
    expect(h.repo.setPolicy).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalled();
  });

  it('策略是原型级：改完只回本原型的详情，memberIds 来自父项目而不是请求体', async () => {
    const h = createHarness();
    const detail = await h.service.setPolicy(ACTOR, '31', { accessMode: 'member' }, REQUEST);
    expect(detail.memberIds).toEqual(['3']);
    expect(h.projects.members).toHaveBeenCalledWith(9n);
  });
});

describe('归档与恢复（§4.3.7/§4.3.8）', () => {
  it('归档写 status=archived 并落 archived_at', async () => {
    const h = createHarness();
    await h.service.setArchived(ACTOR, '31', true, REQUEST);
    const [id, status, archivedAt] = h.repo.setStatus.mock.calls[0] ?? [];
    expect(id).toBe(31n);
    expect(status).toBe('archived');
    expect(archivedAt).toBeInstanceOf(Date);
  });

  it('恢复时状态由"有没有当前版本"重新推导：没发过版回 draft', async () => {
    const h = createHarness();
    await h.service.setArchived(ACTOR, '31', false, REQUEST);
    expect(h.repo.setStatus.mock.calls[0]?.[1]).toBe('draft');
    expect(h.repo.setStatus.mock.calls[0]?.[2]).toBeNull();
  });

  it('发过版的原型恢复后回 published（不引入第二个状态真相）', async () => {
    const h = createHarness(prototypeRow({ currentReleaseId: 77n, status: 'archived' }));
    await h.service.setArchived(ACTOR, '31', false, REQUEST);
    expect(h.repo.setStatus.mock.calls[0]?.[1]).toBe('published');
  });
});

describe('编辑与列表', () => {
  it('PUT 传 code：忽略它并回 PROTO_CODE_IMMUTABLE 警告（§4.1.5 同款语义）', async () => {
    const h = createHarness();
    const result = await h.service.update(
      ACTOR,
      '31',
      { code: 'sneaky', name: '改了名' },
      REQUEST,
    );
    expect(result.warnings).toEqual(['PROTO_CODE_IMMUTABLE']);
    expect(h.repo.update.mock.calls[0]?.[0]).not.toHaveProperty('code');
  });

  it('列表先确认父项目可达；项目不在范围内时不查原型表（§6.2 + 不区分"不存在/无权限"）', async () => {
    const h = createHarness();
    h.projects.findAccessible.mockRejectedValue(
      new BusinessException('项目不存在或你没有访问权限', 'PROTO_NOT_ACCESSIBLE', 403),
    );
    await expect(
      h.service.list(ACTOR, { projectId: '9' }, { ...EMPTY_PAGE, sortBy: 'sort', sortOrder: 'asc' }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(h.repo.findPaged).not.toHaveBeenCalled();
  });

  it('访问地址由服务端拼（PUBLIC_BASE_URL + 两级编码），前端不再各拼一遍域名', async () => {
    const h = createHarness();
    h.repo.findPaged.mockResolvedValue({
      aggregates: new Map([['31', NO_AGGREGATES]]),
      rows: [prototypeRow()],
      total: 1,
    });
    const page = await h.service.list(
      ACTOR,
      { projectId: '9' },
      { ...EMPTY_PAGE, sortBy: 'sort', sortOrder: 'asc' },
    );
    expect(page.items[0]?.accessPath).toBe('/p/crm/crm-p01');
    expect(page.items[0]?.accessUrl).toBe('https://proto.example.com/p/crm/crm-p01');
    expect(page.total).toBe(1);
  });

  it('详情里的 passwordHash 不外泄，只给 hasAccessPassword', async () => {
    const h = createHarness(prototypeRow({ accessMode: 'password', hasAccessPassword: true }));
    const detail = await h.service.detail(ACTOR, '31');
    expect(detail.hasAccessPassword).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('passwordHash');
  });
});

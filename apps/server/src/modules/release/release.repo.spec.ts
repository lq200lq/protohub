import { describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import { CODE_AUTOGEN_MAX_RETRY } from '../../config/constants';
import type { ProjectRepo } from '../project/project.repo';
import type { PrototypeRepo } from '../prototype/prototype.repo';
import { ReleaseRepo, type AcceptInput, type AcceptTarget } from './release.repo';

/**
 * 受理事务单测（机制 §3.0 + 决策 D-20，计划 M3-T2）。
 *
 * Prisma 用假事务客户端桩掉：这里钉的是**事务边界与撞码归属**这两件只有 repo 负责的事——
 * 1. project/prototype/task 三条写必须走同一个 `$transaction` 回调，
 *    这样"轻校验过了但落库失败"不会留下半个容器；
 * 2. 撞唯一索引时**只有自动码才重试**（重试单位是整个事务：PG 里一条语句失败就废掉当前事务），
 *    手填码要 409 让人重新检查（§1.4）；
 * 3. 新建项目必须同时把创建者加成 owner，否则数据范围（权限模型 §6.2）会让人看不见自己刚建的项目。
 *
 * `FOR UPDATE SKIP LOCKED`、version_no 取号这些要到库里才验得的事，属于 M3-T16 的集成测试。
 */

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const INPUT: AcceptInput = {
  createdBy: 4n,
  idempotencyKey: null,
  note: '改了配色',
  sourceName: 'login-flow.zip',
  sourceSize: 2048,
  tempKey: 'tmp/upload-pending-abcd1234.zip',
};

const AUTO_TARGET: AcceptTarget = {
  kind: 'createProject',
  project: { code: null, description: null, name: 'CRM系统' },
  prototype: { code: null, description: null, name: '登录页演示' },
};

const HANDFILLED_TARGET: AcceptTarget = {
  kind: 'createProject',
  project: { code: 'crm', description: null, name: 'CRM系统' },
  prototype: { code: 'login-flow', description: null, name: '登录页演示' },
};

interface HarnessOptions {
  /** 前 N 次事务里 createProject 抛 P2002（模拟并发抢码）。 */
  readonly projectConflicts?: number;
  /** 前 N 次事务里 createOn(prototype) 抛 P2002。 */
  readonly prototypeConflicts?: number;
  /** createProject 直接抛的其它错误：用来确认非撞码异常不会被改写成"编码冲突"。 */
  readonly projectError?: Error;
}

interface Harness {
  readonly addMember: ReturnType<typeof vi.fn>;
  readonly createPrototype: ReturnType<typeof vi.fn>;
  readonly protoUploadTaskCreate: ReturnType<typeof vi.fn>;
  readonly repo: ReleaseRepo;
  readonly transactions: ReturnType<typeof vi.fn>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const conflictsAt = (limit: number | undefined, attempt: number): boolean =>
    limit !== undefined && attempt <= limit;

  const addMember = vi.fn().mockResolvedValue(undefined);
  const createPrototype = vi.fn();
  const protoUploadTaskCreate = vi.fn().mockResolvedValue({ id: 77n });
  let attempt = 0;

  const client = {
    protoProject: { findUniqueOrThrow: vi.fn().mockResolvedValue({ code: 'crm' }) },
    protoPrototype: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ code: 'crm-p01', projectId: 9n }),
    },
    protoUploadTask: { create: protoUploadTaskCreate },
  };
  const projects = {
    addMemberOn: addMember,
    createOn: vi.fn(async () => {
      if (options.projectError !== undefined) {
        throw options.projectError;
      }
      if (conflictsAt(options.projectConflicts, attempt)) {
        throw P2002;
      }
      return 9n;
    }),
  };
  const prototypes = {
    activeCodesInProjectOn: vi.fn().mockResolvedValue([]),
    createOn: createPrototype.mockImplementation(async () => {
      if (conflictsAt(options.prototypeConflicts, attempt)) {
        throw P2002;
      }
      return 31n;
    }),
    isCodeConflict: (error: unknown) =>
      (error as { code?: string } | undefined)?.code === 'P2002',
  };
  const transactions = vi.fn(
    async (work: (c: typeof client) => Promise<unknown>): Promise<unknown> => {
      attempt += 1;
      return work(client);
    },
  );
  const repo = new ReleaseRepo(
    { $transaction: transactions } as never,
    projects as unknown as ProjectRepo,
    prototypes as unknown as PrototypeRepo,
  );
  return { addMember, createPrototype, protoUploadTaskCreate, repo, transactions };
}

describe('§3.0 受理事务的内容', () => {
  it('新建项目 + 原型 + 任务：三条写全部在同一个事务回调里', async () => {
    const h = createHarness();

    const accepted = await h.repo.accept(AUTO_TARGET, INPUT);

    expect(accepted.taskId).toBe(77n);
    expect(accepted.prototypeId).toBe(31n);
    expect(accepted.projectId).toBe(9n);
    expect(h.transactions).toHaveBeenCalledTimes(1);
    expect(h.addMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberRole: 'owner', projectId: 9n, userId: 4n }),
    );
    expect(h.protoUploadTaskCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          note: '改了配色',
          progress: 0,
          prototypeId: 31n,
          sourceSize: 2048n,
          status: 'pending',
          tempKey: 'tmp/upload-pending-abcd1234.zip',
        }),
      }),
    );
  });

  it('自动码走 D-20 的形状：项目 `p-`+8 位、原型 `{项目码}-p01`', async () => {
    const h = createHarness();

    const accepted = await h.repo.accept(AUTO_TARGET, INPUT);

    expect(accepted.projectCode).toMatch(/^p-[0-9a-z]{8}$/);
    expect(accepted.prototypeCode).toBe(`${accepted.projectCode}-p01`);
  });

  it('手填编码原样落库，不自动生成', async () => {
    const h = createHarness();

    const accepted = await h.repo.accept(HANDFILLED_TARGET, INPUT);

    expect(accepted.projectCode).toBe('crm');
    expect(accepted.prototypeCode).toBe('login-flow');
  });

  it('给已有原型追加版本：只写任务行，容器一个都不动', async () => {
    const h = createHarness();

    const accepted = await h.repo.accept({ kind: 'append', prototypeId: 31n }, INPUT);

    expect(accepted).toEqual({
      projectCode: 'crm',
      projectId: 9n,
      prototypeCode: 'crm-p01',
      prototypeId: 31n,
      taskId: 77n,
    });
    expect(h.protoUploadTaskCreate).toHaveBeenCalledOnce();
  });

  it('挂到已有项目下新建原型：用同一个事务读到的项目码取号', async () => {
    const h = createHarness();
    const target: AcceptTarget = {
      kind: 'createPrototype',
      projectId: 9n,
      prototype: { code: null, description: null, name: '登录页演示' },
    };

    const accepted = await h.repo.accept(target, INPUT);

    expect(accepted.projectCode).toBe('crm');
    expect(accepted.prototypeCode).toBe('crm-p01');
  });
});

describe('撞唯一索引的归属判定（§3.0 的重试规则）', () => {
  it('自动项目码撞码 → 重跑整个事务直到成功', async () => {
    const h = createHarness({ projectConflicts: 1 });

    const accepted = await h.repo.accept(AUTO_TARGET, INPUT);

    expect(accepted.taskId).toBe(77n);
    expect(h.transactions).toHaveBeenCalledTimes(2);
  });

  it('自动原型码撞码 → 同样重跑整个事务', async () => {
    const h = createHarness({ prototypeConflicts: 2 });

    const accepted = await h.repo.accept(AUTO_TARGET, INPUT);

    expect(accepted.prototypeId).toBe(31n);
    expect(h.transactions).toHaveBeenCalledTimes(3);
  });

  it('连撞上限 → 409 并把"为什么不再试了"说清楚', async () => {
    const h = createHarness({ projectConflicts: CODE_AUTOGEN_MAX_RETRY + 3 });

    await expect(h.repo.accept(AUTO_TARGET, INPUT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_SLUG_DUPLICATED,
      httpStatus: 409,
      message: `自动生成项目编码连续 ${String(CODE_AUTOGEN_MAX_RETRY)} 次冲突，请稍后重试`,
    });
    expect(h.transactions).toHaveBeenCalledTimes(CODE_AUTOGEN_MAX_RETRY);
  });

  it('手填项目码撞码 → 一次都不重试，直接回"刚被其他项目占用"', async () => {
    const h = createHarness({ projectConflicts: 1 });

    await expect(h.repo.accept(HANDFILLED_TARGET, INPUT)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_SLUG_DUPLICATED,
      httpStatus: 409,
      message: '该编码刚被其他项目占用，请重新检查',
    });
    expect(h.transactions).toHaveBeenCalledTimes(1);
  });

  it('手填原型码撞码 → 回"同项目的其他原型"', async () => {
    const h = createHarness({ prototypeConflicts: 1 });
    const target: AcceptTarget = {
      kind: 'createPrototype',
      projectId: 9n,
      prototype: { code: 'crm-p01', description: null, name: '登录页演示' },
    };

    await expect(h.repo.accept(target, INPUT)).rejects.toMatchObject({
      httpStatus: 409,
      message: '该编码刚被同项目的其他原型占用，请重新检查',
    });
    expect(h.transactions).toHaveBeenCalledTimes(1);
  });

  it('非撞码的库错误原样抛出（不换个说法掩盖根因）', async () => {
    const h = createHarness({ projectError: new Error('外键约束失败') });

    await expect(h.repo.accept(AUTO_TARGET, INPUT)).rejects.toMatchObject({
      message: '外键约束失败',
    });
    expect(h.transactions).toHaveBeenCalledTimes(1);
  });
});

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { ForbiddenBusinessException } from '../../common/exception/business.exception';
import { ProjectRepo } from './project.repo';

/**
 * ProjectRepo 单测（计划 M2-T1/T2 的落库口径；接口设计 §4.1）。
 * 只钉三条容易在重构中溜掉的规则：403 不区分"不存在/无权限"、软删级联、updated_at 必须前进。
 */

interface FakeDb {
  protoProject: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  protoPrototype: { updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

function createRepo(): { db: FakeDb; repo: ProjectRepo } {
  const db: FakeDb = {
    $transaction: vi.fn(async (operations: readonly unknown[]) => operations),
    protoProject: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
    protoPrototype: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  return { db, repo: new ProjectRepo(db as unknown as PrismaClient) };
}

const ALL = { dataScope: 'all' as const, userId: 7n };

describe('findAccessible', () => {
  it('查不到就 403，且消息不区分"不存在"与"无权限"（否则可以靠状态码探测别人的项目 id）', async () => {
    const { repo } = createRepo();
    await expect(repo.findAccessible(9n, ALL)).rejects.toBeInstanceOf(ForbiddenBusinessException);
  });

  it('where 里叠了 deletedAt: null——软删的项目不能靠 id 直接打开', async () => {
    const { db, repo } = createRepo();
    await repo.findAccessible(9n, ALL).catch(() => undefined);
    const args = db.protoProject.findFirst.mock.calls[0]?.[0] as {
      where: { deletedAt: null; id: bigint };
    };
    expect(args.where).toEqual({ deletedAt: null, id: 9n });
  });

  it('member 范围下把范围条件与业务条件求交（F-5：猜到 id 也打不开别人的项目）', async () => {
    const { db, repo } = createRepo();
    await repo
      .findAccessible(9n, { dataScope: 'member', userId: 7n })
      .catch(() => undefined);
    const args = db.protoProject.findFirst.mock.calls[0]?.[0] as {
      where: { AND?: unknown[] };
    };
    expect(args.where.AND).toBeDefined();
  });
});

describe('写路径', () => {
  it('归档只写 archived_at（项目层唯一状态字段，数据库设计 §4.2.1），并推进 updated_at', async () => {
    const { db, repo } = createRepo();
    await repo.setArchived(9n, new Date('2026-10-06T10:00:00Z'), 3n);
    const args = db.protoProject.update.mock.calls[0]?.[0] as {
      data: { archivedAt: Date; updatedAt: Date };
    };
    expect(args.data.archivedAt.toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(args.data.updatedAt).toBeInstanceOf(Date);
  });

  it('恢复上架把 archived_at 清成 null', async () => {
    const { db, repo } = createRepo();
    await repo.setArchived(9n, null, 3n);
    const args = db.protoProject.update.mock.calls[0]?.[0] as { data: { archivedAt: null } };
    expect(args.data.archivedAt).toBeNull();
  });

  it('改基本信息时显式写 updated_at：schema 里它只有 DEFAULT now()、没有 @updatedAt，不写就不前进', async () => {
    const { db, repo } = createRepo();
    await repo.update({ description: null, id: 9n, name: '新名', updatedBy: 3n });
    const args = db.protoProject.update.mock.calls[0]?.[0] as {
      data: { name: string; updatedAt: Date };
    };
    expect(args.data.name).toBe('新名');
    expect(args.data.updatedAt).toBeInstanceOf(Date);
  });

  it('删项目在同事务里级联软删其下原型（计划 §8 F-6），级联也带 updated_at', async () => {
    const { db, repo } = createRepo();
    await repo.softDelete(9n, 3n);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const cascade = db.protoPrototype.updateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date; updatedAt: Date };
      where: { deletedAt: null; projectId: bigint };
    };
    expect(cascade.where).toEqual({ deletedAt: null, projectId: 9n });
    expect(cascade.data.deletedAt).toBeInstanceOf(Date);
    expect(cascade.data.updatedAt).toEqual(cascade.data.deletedAt);
  });
});

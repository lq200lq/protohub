import { describe, expect, it } from 'vitest';

import {
  andProjectScope,
  andPrototypeScope,
  projectScopeWhere,
  toActorScope,
  type ActorScope,
} from './data-scope';

/**
 * 数据权限查询构造层单测（计划 M2-T2 / M2-T11；口径来自权限模型设计 §6.1/§6.2）。
 * 这里断言的是"生成的 where 片段"，不是 Prisma 行为——范围判定全系统只有这一处，
 * 它错了列表和详情会一起错，所以要能在不连库的情况下被钉住。
 */

const ME: ActorScope = { dataScope: 'all', userId: 7n };

function scope(dataScope: ActorScope['dataScope']): ActorScope {
  return { dataScope, userId: 7n };
}

describe('projectScopeWhere', () => {
  it('all 不加任何过滤', () => {
    expect(projectScopeWhere(scope('all'))).toEqual({});
  });

  it('own 只认 created_by', () => {
    expect(projectScopeWhere(scope('own'))).toEqual({ createdBy: 7n });
  });

  it('member 是「我创建的 ∪ 我参与的」（§6.1：漏了 created_by 会让新建项目在成员表落上前自己看不见）', () => {
    expect(projectScopeWhere(scope('member'))).toEqual({
      OR: [{ createdBy: 7n }, { members: { some: { userId: 7n } } }],
    });
  });

  it('越界的 data_scope 值按最窄处理，不放行', () => {
    // data_scope 在 DB 里是 varchar，CHECK 之外读到的脏值不该变成"全员可见"。
    expect(projectScopeWhere(scope('everything' as ActorScope['dataScope']))).toEqual({
      createdBy: 7n,
    });
  });
});

describe('andProjectScope', () => {
  it('all 时原样返回业务条件（不多套一层 AND）', () => {
    const base = { deletedAt: null, id: 3n };
    expect(andProjectScope(ME, base)).toBe(base);
  });

  it('own/member 把范围与业务条件求交，业务条件里的 deletedAt 不会被范围覆盖掉', () => {
    const where = andProjectScope(scope('own'), {
      deletedAt: null,
      name: { contains: 'CRM' },
    });
    expect(where).toEqual({
      AND: [{ deletedAt: null, name: { contains: 'CRM' } }, { createdBy: 7n }],
    });
  });
});

describe('andPrototypeScope（原型可见性一律通过父项目判定，§6.2）', () => {
  it('父项目条件带 deletedAt：null，项目软删后其原型不再单独可达（计划 §8 F-6）', () => {
    const where = andPrototypeScope(scope('all'), { projectId: 9n });
    expect(where.project).toEqual({ deletedAt: null });
  });

  it('项目侧的范围条件原样下沉到 project', () => {
    const where = andPrototypeScope(scope('member'), { status: 'published' });
    expect(where).toEqual({
      project: {
        OR: [{ createdBy: 7n }, { members: { some: { userId: 7n } } }],
        deletedAt: null,
      },
      status: 'published',
    });
  });

  it('不含 archivedAt：归档影响的是公开链接（M4 的 /api/access/check），后台仍要能管理归档项目的原型', () => {
    const where = andPrototypeScope(scope('all'), {});
    const project = where.project as Record<string, unknown>;
    expect(Object.hasOwn(project, 'archivedAt')).toBe(false);
    expect(Object.hasOwn(where as Record<string, unknown>, 'status')).toBe(false);
  });
});

describe('toActorScope', () => {
  it('字符串 id 只在这里转 bigint（服务层不再比较 string 与 BigInt 字段）', () => {
    expect(toActorScope({ dataScope: 'member', userId: '42' })).toEqual({
      dataScope: 'member',
      userId: 42n,
    });
  });
});

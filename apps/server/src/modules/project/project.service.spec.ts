import { describe, expect, it, vi } from 'vitest';

import type { Actor, RequestMeta } from '../system/common/actor';
import type { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import type { ProjectAggregates, ProjectRepo } from './project.repo';
import { ProjectService, deriveProjectStatus } from './project.service';

/**
 * 项目状态派生单测（决策 D-22，计划 M2-T4）：`status` 不落库，由 archived_at 与其下原型聚合算出。
 * 归档优先这一条是"项目归档 → 其下原型链接不可访问"的判定入口（M4 的 /api/access/check 消费它），
 * M2 先把派生规则钉住，M4 Gate 再端到端点一次链接。
 */

function aggregates(overrides: Partial<ProjectAggregates> = {}): ProjectAggregates {
  return {
    archived: 0,
    draft: 1,
    lastPublishedAt: null,
    published: 0,
    total: 1,
    visitsLast7d: 0,
    ...overrides,
  };
}

describe('deriveProjectStatus', () => {
  it('archived_at 非空即 archived，压过"有已发布原型"', () => {
    expect(deriveProjectStatus(new Date(), aggregates({ published: 5 }))).toBe('archived');
  });

  it('未归档且有已发布原型 → published', () => {
    expect(deriveProjectStatus(null, aggregates({ published: 1 }))).toBe('published');
  });

  it('其余（含全是草稿、全是归档原型）→ draft', () => {
    expect(deriveProjectStatus(null, aggregates())).toBe('draft');
    expect(deriveProjectStatus(null, aggregates({ archived: 3, published: 0, total: 3 }))).toBe(
      'draft',
    );
  });
});

/**
 * §4.1.10 覆盖式成员写入的角色保护（实测中修出来的规则，运行_once 会把创建人从 owner 降成 viewer）。
 * 一期不按 member_role 做差异授权，但 owner 承载"谁建的"这一事实：降级后项目就没有 owner 了，
 * 而 `created_by` 并不会因此改变，界面与数据从此对不上。
 */
const OWNER_ID = 3n;

function memberRow(userId: bigint, memberRole: string, username: string) {
  return {
    createdAt: new Date('2026-10-06T03:00:00.000Z'),
    memberRole,
    userId,
    user: { id: userId, realName: username, username },
  };
}

function membersHarness(validUserIds: readonly string[]) {
  const addMember = vi.fn(
    async (_input: { createdBy: bigint; memberRole: string; projectId: bigint; userId: bigint }) => undefined,
  );
  const repo = {
    addMember,
    existingUserIds: vi.fn(async () => new Set(validUserIds)),
    findAccessible: vi.fn(async () => ({
      archivedAt: null,
      code: 'p-crm00001',
      createdBy: OWNER_ID,
      description: null,
      id: 9n,
      name: 'CRM',
    })),
    members: vi.fn(async () => [memberRow(OWNER_ID, 'owner', 'gateadmin')]),
    removeMembersNotIn: vi.fn(async (_projectId: bigint, _userIds: bigint[]) => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new ProjectService(
    repo as unknown as ProjectRepo,
    audit as unknown as OperationAuditWriter,
  );
  return {
    addMember,
    added: () =>
      addMember.mock.calls.map((call) => [
        call[0].userId.toString(),
        call[0].memberRole,
      ] as const),
    repo,
    service,
  };
}

const ACTOR = { dataScope: 'all', userId: '9' } as unknown as Actor;
const REQUEST = { ip: '127.0.0.1', method: 'PUT', traceId: 't-1', url: '/api/projects/9/members' } as unknown as RequestMeta;

describe('ProjectService.setMembers', () => {
  it('创建人在名单里但没给 memberRole → 仍写 owner，别人的显式角色不受影响', async () => {
    const harness = membersHarness(['3', '4']);

    await harness.service.setMembers(
      ACTOR,
      '9',
      { members: [{ userId: '3' }, { memberRole: 'editor', userId: '4' }] },
      REQUEST,
    );

    expect(harness.added()).toEqual([
      ['3', 'owner'],
      ['4', 'editor'],
    ]);
  });

  it('名单里漏了创建人 → 服务端补回 owner，并且不把他删掉', async () => {
    const harness = membersHarness(['4']);

    await harness.service.setMembers(ACTOR, '9', { members: [{ userId: '4' }] }, REQUEST);

    expect(harness.added()).toEqual([
      ['3', 'owner'],
      ['4', 'viewer'],
    ]);
    const keptIds = harness.repo.removeMembersNotIn.mock.calls[0]?.[1] as bigint[];
    expect(keptIds).toContain(OWNER_ID);
  });

  it('成员 id 指向不存在/已删的用户 → 400 且点名是哪几个', async () => {
    const harness = membersHarness(['3']);

    await expect(
      harness.service.setMembers(
        ACTOR,
        '9',
        { members: [{ userId: '3' }, { userId: '99' }] },
        REQUEST,
      ),
    ).rejects.toThrow(/99/);
    expect(harness.addMember).not.toHaveBeenCalled();
  });
});

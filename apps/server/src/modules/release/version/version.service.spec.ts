import {
  ERROR_CODES,
  type PrototypeDetail,
  UPLOAD_WARNING_CODES,
  type UploadTaskWarning,
} from '@protohub/shared';
import { describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../../../common/exception/business.exception';
import type { ProjectRepo, ProjectRow } from '../../project/project.repo';
import type { PrototypeRepo, PrototypeRow } from '../../prototype/prototype.repo';
import type { PrototypeService } from '../../prototype/prototype.service';
import type { Actor, RequestMeta } from '../../system/common/actor';
import type { OperationAuditWriter } from '../../system/audit/operation-audit.writer';
import type {
  ProjectReleaseEventRow,
  ReleaseEventRow,
  ReleaseRow,
  VersionRepo,
} from './version.repo';
import { VersionService } from './version.service';

/**
 * VersionService 单测（计划 M3-T9；接口设计 §5.4–§5.8）。
 *
 * 桩掉全部 repo：这里钉的是**服务层该管的那部分**——数据范围先行、`isCurrent` 取自原型行、
 * 排序白名单、审计的模块/动作/资源类型，以及 §5.6 三种结果各自的 HTTP 语义。
 * 事务内的规则（归档拦截、`ready` 判定、当前版本不能删）由 `version.repo.ts` 在行锁里判，
 * 那些断言在真实库上测（本轮的 HTTP 实测 + M3-T16 的集成测试），mock 测出来只会是"我调了我自己"。
 */

const ACTOR: Actor = {
  dataScope: 'all',
  isSuperAdmin: false,
  roles: ['admin'],
  userId: '3',
  username: 'gateadmin',
};
const REQUEST: RequestMeta = { ip: '127.0.0.1', method: 'POST', path: '/api/prototypes/31/rollback' };
const EMPTY_PAGE = { page: 1, pageSize: 20, skip: 0 };

/** §3.5 发布报告的一条：消息正文由服务端写好，服务层只搬运不重算（机制 §2.7）。 */
const RELEASE_REPORT_ENTRY: UploadTaskWarning = {
  code: UPLOAD_WARNING_CODES.BASE_TAG_FOUND,
  count: 1,
  message: '检测到 1 处 <base> 标签，平台未改写，请自行确认相对路径',
};

function prototypeRow(overrides: Partial<PrototypeRow> = {}): PrototypeRow {
  return {
    accessMode: 'public',
    archivedAt: null,
    code: 'crm-p01',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    createdBy: 3n,
    currentReleaseId: 77n,
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
    status: 'published',
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

function releaseRow(overrides: Partial<ReleaseRow> = {}): ReleaseRow {
  return {
    contentHash: 'a1b2',
    createdAt: new Date('2026-10-06T06:30:00Z'),
    createdByName: '张三',
    entryFile: 'index.html',
    fileCount: 42,
    htmlRewrites: 12,
    id: 77n,
    note: '首页改版',
    cssRewrites: 3,
    report: [RELEASE_REPORT_ENTRY],
    sourceSize: 3145728,
    status: 'ready',
    totalBytes: 5242880,
    versionNo: 3,
    ...overrides,
  };
}

function eventRow(overrides: Partial<ReleaseEventRow> = {}): ReleaseEventRow {
  return {
    createdAt: new Date('2026-10-06T06:30:00Z'),
    eventType: 'publish',
    fromVersionNo: null,
    id: 41n,
    operatorName: '张三',
    reason: null,
    toVersionNo: 3,
    ...overrides,
  };
}

interface Harness {
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly projects: { findAccessible: ReturnType<typeof vi.fn> };
  readonly prototypes: { findAccessible: ReturnType<typeof vi.fn> };
  readonly prototypeService: { detail: ReturnType<typeof vi.fn> };
  readonly versions: {
    findSummary: ReturnType<typeof vi.fn>;
    listForPrototype: ReturnType<typeof vi.fn>;
    listProjectEvents: ReturnType<typeof vi.fn>;
    listPrototypeEvents: ReturnType<typeof vi.fn>;
    markDeleted: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    sourceNamesOf: ReturnType<typeof vi.fn>;
  };
  readonly service: VersionService;
}

function harness(): Harness {
  const versions = {
    findSummary: vi.fn(),
    listForPrototype: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    listProjectEvents: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    listPrototypeEvents: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    markDeleted: vi.fn(),
    rollback: vi.fn(),
    sourceNamesOf: vi.fn().mockResolvedValue(new Map<string, string>()),
  };
  const prototypes = {
    findAccessible: vi.fn().mockResolvedValue(prototypeRow()),
  };
  const projects = {
    findAccessible: vi.fn().mockResolvedValue({ id: 9n } as ProjectRow),
  };
  const prototypeService = {
    detail: vi.fn().mockResolvedValue({ id: '31' } as unknown as PrototypeDetail),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new VersionService(
    versions as unknown as VersionRepo,
    prototypes as unknown as PrototypeRepo,
    projects as unknown as ProjectRepo,
    prototypeService as unknown as PrototypeService,
    audit as unknown as OperationAuditWriter,
  );
  return { audit, projects, prototypes, prototypeService, service, versions };
}

describe('§5.4 版本列表', () => {
  it('isCurrent 由原型行的 currentReleaseId 决定，sourceName 缺失时回 null', async () => {
    const h = harness();
    h.versions.listForPrototype.mockResolvedValue({
      rows: [releaseRow(), releaseRow({ id: 70n, note: null, versionNo: 2 })],
      total: 2,
    });
    h.versions.sourceNamesOf.mockResolvedValue(new Map([['77', 'login-prototype.zip']]));

    const result = await h.service.list(ACTOR, '31', {});

    expect(result.total).toBe(2);
    expect(result.items[0]).toMatchObject({
      id: '77',
      isCurrent: true,
      note: '首页改版',
      report: [RELEASE_REPORT_ENTRY],
      sourceName: 'login-prototype.zip',
      versionNo: 3,
      warnings: { cssRewrites: 3, htmlRewrites: 12 },
    });
    expect(result.items[1]).toMatchObject({ isCurrent: false, note: null, sourceName: null });
  });

  it('默认按 versionNo 排序，非白名单字段 400（不静默忽略）', async () => {
    const h = harness();
    await h.service.list(ACTOR, '31', {});
    expect(h.versions.listForPrototype).toHaveBeenCalledWith(31n, {
      ...EMPTY_PAGE,
      sortBy: 'versionNo',
    });

    await expect(h.service.list(ACTOR, '31', { sortBy: 'size' })).rejects.toMatchObject({
      errorCode: ERROR_CODES.PARAM_INVALID,
      httpStatus: 400,
    });
  });

  it('原型不在范围内时不查版本（范围判定只有一处实现）', async () => {
    const h = harness();
    h.prototypes.findAccessible.mockRejectedValue(
      new BusinessException('无权访问该原型', ERROR_CODES.PROTO_NOT_ACCESSIBLE, 403),
    );
    await expect(h.service.list(ACTOR, '31', {})).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_NOT_ACCESSIBLE,
    });
    expect(h.versions.listForPrototype).not.toHaveBeenCalled();
  });
});

describe('§5.5 回滚', () => {
  it('事务里的规则交给 repo，服务层只补范围、审计与响应体', async () => {
    const h = harness();
    h.versions.rollback.mockResolvedValue({ fromVersionNo: 3, toVersionNo: 1 });

    const detail = await h.service.rollback(ACTOR, '31', { reason: '新版样式被否', releaseId: '70' }, REQUEST);

    expect(h.versions.rollback).toHaveBeenCalledWith({
      prototypeId: 31n,
      reason: '新版样式被否',
      releaseId: 70n,
      userId: 3n,
    });
    expect(detail).toEqual({ id: '31' } as unknown as PrototypeDetail);
    expect(h.prototypeService.detail).toHaveBeenCalledWith(ACTOR, '31');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rollback',
        detail: { fromVersionNo: 3, reason: '新版样式被否', releaseId: '70', toVersionNo: 1 },
        module: 'proto:release',
        resourceId: '31',
        resourceName: '登录页演示',
        resourceType: 'prototype',
      }),
    );
  });

  it('原因留空写 null，而不是空串（§1.5）', async () => {
    const h = harness();
    h.versions.rollback.mockResolvedValue({ fromVersionNo: null, toVersionNo: 2 });
    await h.service.rollback(ACTOR, '31', { releaseId: '70' }, REQUEST);
    expect(h.versions.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: null }),
    );
  });
});

describe('§5.6 删除版本', () => {
  it('当前生效版本 → 400 RELEASE_IS_CURRENT，且不写审计', async () => {
    const h = harness();
    h.versions.markDeleted.mockResolvedValue({ kind: 'current' });
    await expect(h.service.removeRelease(ACTOR, '31', '77', REQUEST)).rejects.toMatchObject({
      errorCode: ERROR_CODES.RELEASE_IS_CURRENT,
      httpStatus: 400,
    });
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('不存在/已删过 → 404 RELEASE_NOT_FOUND', async () => {
    const h = harness();
    h.versions.markDeleted.mockResolvedValue({ kind: 'not-found' });
    await expect(h.service.removeRelease(ACTOR, '31', '70', REQUEST)).rejects.toMatchObject({
      errorCode: ERROR_CODES.RELEASE_NOT_FOUND,
      httpStatus: 404,
    });
  });

  it('删除成功按版本号写审计（时间线要能说出删了第几版）', async () => {
    const h = harness();
    h.versions.markDeleted.mockResolvedValue({ kind: 'deleted', versionNo: 2 });
    await h.service.removeRelease(ACTOR, '31', '70', REQUEST);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete',
        detail: { prototypeId: '31', releaseId: '70', versionNo: 2 },
        module: 'proto:release',
        resourceId: '70',
        resourceName: 'v2',
        resourceType: 'release',
      }),
    );
  });
});

describe('§5.8 时间线与项目动态', () => {
  it('原型时间线按 createdAt 排，项目动态多带原型名与原型码', async () => {
    const h = harness();
    const projectEvent: ProjectReleaseEventRow = {
      ...eventRow({ eventType: 'rollback', fromVersionNo: 3, toVersionNo: 1 }),
      prototypeCode: 'crm-p01',
      prototypeName: '登录页演示',
    };
    h.versions.listProjectEvents.mockResolvedValue({ rows: [projectEvent], total: 1 });

    await h.service.prototypeEvents(ACTOR, '31', {});
    expect(h.versions.listPrototypeEvents).toHaveBeenCalledWith(31n, {
      ...EMPTY_PAGE,
      sortBy: 'createdAt',
    });

    const result = await h.service.projectEvents(ACTOR, '9', {});
    expect(result.items[0]).toMatchObject({
      eventType: 'rollback',
      fromVersionNo: 3,
      prototypeCode: 'crm-p01',
      prototypeName: '登录页演示',
      toVersionNo: 1,
    });
  });

  it('项目不在范围内时不查事件', async () => {
    const h = harness();
    h.projects.findAccessible.mockRejectedValue(
      new BusinessException('无权访问该项目', ERROR_CODES.PROTO_NOT_ACCESSIBLE, 403),
    );
    await expect(h.service.projectEvents(ACTOR, '9', {})).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_NOT_ACCESSIBLE,
    });
    expect(h.versions.listProjectEvents).not.toHaveBeenCalled();
  });
});

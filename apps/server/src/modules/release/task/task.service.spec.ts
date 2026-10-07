import { ERROR_CODES, type UploadTaskWarning } from '@protohub/shared';
import { describe, expect, it, vi } from 'vitest';

import { BusinessException } from '../../../common/exception/business.exception';
import type { AppEnvService } from '../../../config/app-env.service';
import type { PrototypeRepo } from '../../prototype/prototype.repo';
import type { ReleaseRow, VersionRepo } from '../version/version.repo';
import type { TaskStatusRow, UploadTaskRepo } from '../worker/upload-task.repo';
import type { Actor } from '../../system/common/actor';
import { UploadTaskService } from './task.service';

/**
 * §5.3 任务状态的单测（计划 M3-T9）。
 *
 * 钉三件服务层该管的事：**没这条任务**（404）、**任务不属于你**（403，由 findAccessible 抛）、
 * 以及响应体的组装规则——`release` 只在成功时给、`error.message` 优先用库里那句原文（机制 §8.2）、
 * `publishedAt` 取版本行自己的时间。阶段/进度/警告的数值来自 Worker，那里另有测试。
 */

const ACTOR: Actor = {
  dataScope: 'all',
  isSuperAdmin: false,
  roles: ['admin'],
  userId: '3',
  username: 'gateadmin',
};

const LIMITS = {
  maxBytes: 104_857_600,
  maxEntries: 5_000,
  maxFileBytes: 209_715_200,
  maxRatio: 200,
  maxTotalBytes: 524_288_000,
};

const WARNING: UploadTaskWarning = {
  code: 'REWRITE_ABSOLUTE_PATH',
  count: 12,
  message: '已将 12 处根绝对路径改写为 /p/crm/crm-p01/ 前缀',
};

function taskRow(overrides: Partial<TaskStatusRow> = {}): TaskStatusRow {
  return {
    errorCode: null,
    errorMessage: null,
    id: 128n,
    progress: 65,
    projectCode: 'crm',
    projectId: 9n,
    prototypeCode: 'crm-p01',
    prototypeId: 31n,
    releaseId: null,
    sourceName: 'login-prototype.zip',
    sourceSize: 3145728,
    stage: 'postprocess',
    status: 'processing',
    warnings: [WARNING],
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
    note: null,
    cssRewrites: 3,
    report: [],
    sourceSize: 3145728,
    status: 'ready',
    totalBytes: 3145728,
    versionNo: 3,
    ...overrides,
  };
}

interface Harness {
  readonly prototypes: { findAccessible: ReturnType<typeof vi.fn> };
  readonly service: UploadTaskService;
  readonly tasks: { findForStatus: ReturnType<typeof vi.fn> };
  readonly versions: { findSummary: ReturnType<typeof vi.fn> };
}

function harness(): Harness {
  const tasks = { findForStatus: vi.fn() };
  const versions = { findSummary: vi.fn().mockResolvedValue(releaseRow()) };
  const prototypes = { findAccessible: vi.fn().mockResolvedValue({ id: 31n }) };
  const appEnv = {
    env: { http: { publicBaseUrl: 'http://127.0.0.1:3100' }, upload: LIMITS },
  };
  const service = new UploadTaskService(
    tasks as unknown as UploadTaskRepo,
    versions as unknown as VersionRepo,
    prototypes as unknown as PrototypeRepo,
    appEnv as unknown as AppEnvService,
  );
  return { prototypes, service, tasks, versions };
}

describe('§5.3 任务状态', () => {
  it('任务不存在 → 404 UPLOAD_TASK_NOT_FOUND（不区分"没这条"与"不是你的"）', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(null);
    await expect(h.service.status(ACTOR, '128')).rejects.toMatchObject({
      errorCode: ERROR_CODES.UPLOAD_TASK_NOT_FOUND,
      httpStatus: 404,
    });
    expect(h.prototypes.findAccessible).not.toHaveBeenCalled();
  });

  it('id 不是数字 → 400，而不是 BigInt 抛异常变 500', async () => {
    const h = harness();
    await expect(h.service.status(ACTOR, 'abc')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PARAM_INVALID,
    });
    expect(h.tasks.findForStatus).not.toHaveBeenCalled();
  });

  it('范围一律问父项目：不在范围内就不读版本摘要', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(taskRow({ releaseId: 77n, status: 'success' }));
    h.prototypes.findAccessible.mockRejectedValue(
      new BusinessException('无权访问该原型', ERROR_CODES.PROTO_NOT_ACCESSIBLE, 403),
    );
    await expect(h.service.status(ACTOR, '128')).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_NOT_ACCESSIBLE,
      httpStatus: 403,
    });
    expect(h.prototypes.findAccessible).toHaveBeenCalledWith(31n, { dataScope: 'all', userId: 3n });
    expect(h.versions.findSummary).not.toHaveBeenCalled();
  });

  it('processing：进度/阶段/警告如实透传，release 与 error 都是 null', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(taskRow());

    const result = await h.service.status(ACTOR, '128');

    expect(result).toEqual({
      error: null,
      progress: 65,
      projectId: '9',
      prototypeId: '31',
      release: null,
      sourceName: 'login-prototype.zip',
      sourceSize: 3145728,
      stage: 'postprocess',
      status: 'processing',
      taskId: '128',
      warnings: [WARNING],
    });
    expect(h.versions.findSummary).not.toHaveBeenCalled();
  });

  it('failed：文案用任务行里那句原文，不在前端/服务端重算', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(
      taskRow({
        errorCode: 'UPLOAD_UNSAFE_PATH',
        errorMessage: '压缩包内含非法路径（绝对路径或 ..）：../../etc/passwd',
        progress: 35,
        stage: 'extracting',
        status: 'failed',
        warnings: [],
      }),
    );

    const result = await h.service.status(ACTOR, '128');

    expect(result.error).toEqual({
      errorCode: 'UPLOAD_UNSAFE_PATH',
      message: '压缩包内含非法路径（绝对路径或 ..）：../../etc/passwd',
    });
    expect(result.release).toBeNull();
  });

  it('PROTO_NOT_FOUND 的建议操作是"重新选择目标"，不是那 13 码的"重试"（DEV-18）', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(
      taskRow({
        errorCode: ERROR_CODES.PROTO_NOT_FOUND,
        errorMessage: null,
        status: 'failed',
      }),
    );
    const result = await h.service.status(ACTOR, '128');
    expect(result.error).toEqual({
      errorCode: ERROR_CODES.PROTO_NOT_FOUND,
      message: '原型已删除，请重新选择目标',
    });
  });

  it('success：release 带访问地址，publishedAt 是那一版自己的时间', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(
      taskRow({
        progress: 100,
        releaseId: 77n,
        stage: 'committing',
        status: 'success',
      }),
    );

    const result = await h.service.status(ACTOR, '128');

    expect(result.release).toEqual({
      accessPath: '/p/crm/crm-p01',
      accessUrl: 'http://127.0.0.1:3100/p/crm/crm-p01',
      contentHash: 'a1b2',
      entryFile: 'index.html',
      fileCount: 42,
      id: '77',
      projectId: '9',
      prototypeId: '31',
      publishedAt: '2026-10-06T06:30:00.000Z',
      totalBytes: 3145728,
      versionNo: 3,
    });
  });

  it('success 但版本行读不到（人工删过）：如实回 release=null，不编一个摘要', async () => {
    const h = harness();
    h.tasks.findForStatus.mockResolvedValue(
      taskRow({ releaseId: 77n, status: 'success', stage: 'committing', progress: 100 }),
    );
    h.versions.findSummary.mockResolvedValue(null);
    const result = await h.service.status(ACTOR, '128');
    expect(result.status).toBe('success');
    expect(result.release).toBeNull();
  });
});

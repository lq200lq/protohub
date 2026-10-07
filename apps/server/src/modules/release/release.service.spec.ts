import { access, constants, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../common/exception/business.exception';
import { IDEMPOTENCY_WINDOW_MS } from '../../config/constants';
import type { PermissionCodeService } from '../../common/permission/permission-code.service';
import type { AppEnvService } from '../../config/app-env.service';
import type { StorageAdapter } from '../storage/storage.adapter';
import type { Actor, RequestMeta } from '../system/common/actor';
import type { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import type { ProjectRepo, ProjectRow } from '../project/project.repo';
import type { PrototypeRepo, PrototypeRow } from '../prototype/prototype.repo';
import { intakeUpload } from './pipeline/intake';
import { assertZipMagic, inspectZip } from './pipeline/validate';
import type { UploadLimits } from './pipeline/errors';
import type { ReleaseRepo } from './release.repo';
import { ReleaseService, type ReleaseRequest } from './release.service';

/**
 * 上传受理的服务层单测（计划 M3-T2 判据 + 接口设计 §5.1/§1.5 + 机制 §2.7/§3.0）。
 *
 * 桩掉的是三类外部事实：`intake`（流式收包，另有 intake.spec.ts 覆盖真实行为）、
 * `validate`（zip 中央目录判定，另有 validate.spec.ts）、以及 Prisma（repo 全部 vi.fn）。
 * 这里钉的是**只有服务层负责**的编排规则：
 * 1. **轻校验不过时一条库记录都不许有**，半截文件当场删掉（计划 M3-T2 的验收判据）；
 * 2. §5.1 的 AND 权限要指名缺哪一枚码；
 * 3. §2.7 的同包重传回 `UPLOAD_DUPLICATE_CONTENT`，`force` 才继续；
 * 4. §1.5 的幂等回放发生在**收包之前**（否则双击提交要重传 100MB 才算幂等）；
 * 5. 受理成功后把过渡文件换成 §1.2 的正式名并回填 temp_key。
 */

vi.mock('./pipeline/intake', () => ({ intakeUpload: vi.fn() }));
// assertZipMagic / inspectZip 是"读磁盘上的 zip"这两件外部事实，桩掉；
// assertInspectable 是受理阶段真正的判定规则，**保持真实实现**，否则"缺入口不落库"只是在测桩。
vi.mock('./pipeline/validate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pipeline/validate')>()),
  assertZipMagic: vi.fn(),
  inspectZip: vi.fn(),
}));

const ACTOR: Actor = {
  userId: '4',
  username: 'gatepub',
  roles: ['publisher'],
  isSuperAdmin: false,
  dataScope: 'own',
};
const META: RequestMeta = { ip: '127.0.0.1', method: 'POST', path: '/api/releases' };

const LIMITS: UploadLimits = {
  maxEntries: 5000,
  maxFileBytes: 20 * 1024 * 1024,
  maxRatio: 50,
  maxTotalBytes: 500 * 1024 * 1024,
  maxUploadBytes: 100 * 1024 * 1024,
};

const PENDING_KEY = 'tmp/upload-pending-abcd1234.zip';
const SOURCE_HASH = 'a'.repeat(64);

const PROTOTYPE_JSON = JSON.stringify({ name: '登录页演示' });
const PROJECT_JSON = JSON.stringify({ name: 'CRM系统' });

function projectRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    archivedAt: null,
    code: 'crm',
    createdAt: new Date('2026-10-06T09:00:00Z'),
    createdBy: 4n,
    createdByName: '李四',
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
    createdBy: 4n,
    currentReleaseId: 55n,
    description: null,
    firstPublishedAt: new Date('2026-10-01T10:00:00Z'),
    hasAccessPassword: false,
    id: 31n,
    name: '登录页演示',
    policyVersion: 1,
    projectCode: 'crm',
    projectId: 9n,
    publishedAt: new Date('2026-10-01T10:00:00Z'),
    sort: 0,
    status: 'published',
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

interface IntakeShape {
  readonly absPath: string;
  readonly fields: Record<string, string>;
  readonly pendingKey: string;
  readonly random: string;
  readonly sourceHash: string;
  readonly sourceName: string;
  readonly sourceSize: number;
}

function intakeOf(fields: Record<string, string>, absPath: string): IntakeShape {
  return {
    absPath,
    fields,
    pendingKey: PENDING_KEY,
    random: 'abcd1234',
    sourceHash: SOURCE_HASH,
    sourceName: 'login-flow.zip',
    sourceSize: 2048,
  };
}

interface Harness {
  readonly audit: { record: ReturnType<typeof vi.fn> };
  readonly permissionCodes: { codesOfUser: ReturnType<typeof vi.fn> };
  readonly projects: { findAccessible: ReturnType<typeof vi.fn>; findActiveByCode: ReturnType<typeof vi.fn> };
  readonly prototypes: { findAccessible: ReturnType<typeof vi.fn>; findActiveByCode: ReturnType<typeof vi.fn> };
  readonly repo: {
    accept: ReturnType<typeof vi.fn>;
    currentSourceHash: ReturnType<typeof vi.fn>;
    findRecentAcceptance: ReturnType<typeof vi.fn>;
    setTempKey: ReturnType<typeof vi.fn>;
  };
  readonly service: ReleaseService;
  readonly storage: { localPathOf: ReturnType<typeof vi.fn>; moveIntoService: ReturnType<typeof vi.fn> };
}

const ACCEPTED = {
  projectCode: 'crm',
  projectId: 9n,
  prototypeCode: 'crm-p01',
  prototypeId: 31n,
  taskId: 77n,
};

function createHarness(): Harness {
  const repo = {
    accept: vi.fn().mockResolvedValue(ACCEPTED),
    currentSourceHash: vi.fn().mockResolvedValue(null),
    findRecentAcceptance: vi.fn().mockResolvedValue(null),
    setTempKey: vi.fn().mockResolvedValue(undefined),
  };
  const projects = {
    findAccessible: vi.fn().mockResolvedValue(projectRow()),
    findActiveByCode: vi.fn().mockResolvedValue(null),
  };
  const prototypes = {
    findAccessible: vi.fn().mockResolvedValue(prototypeRow()),
    findActiveByCode: vi.fn().mockResolvedValue(null),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const permissionCodes = {
    codesOfUser: vi.fn().mockResolvedValue(
      new Set(['proto:prototype:publish', 'proto:project:create', 'proto:prototype:create']),
    ),
  };
  const storage = {
    localPathOf: vi.fn((key: string) => `/storage/${key}`),
    moveIntoService: vi.fn().mockResolvedValue(undefined),
  };
  const appEnv = { env: { upload: LIMITS } };
  const service = new ReleaseService(
    repo as unknown as ReleaseRepo,
    projects as unknown as ProjectRepo,
    prototypes as unknown as PrototypeRepo,
    audit as unknown as OperationAuditWriter,
    appEnv as unknown as AppEnvService,
    permissionCodes as unknown as PermissionCodeService,
    storage as unknown as StorageAdapter,
  );
  return { audit, permissionCodes, projects, prototypes, repo, service, storage };
}

function requestWith(headers: Record<string, unknown> = {}): ReleaseRequest {
  return {
    headers,
    // intake 已被桩掉，这两个方法只要形状在；真实的分片消费行为由 intake.spec.ts 覆盖。
    async *parts(): AsyncGenerator<never> {
      // 故意不产出任何分片
    },
    isMultipart(): boolean {
      return true;
    },
    method: 'POST',
    url: '/api/releases',
  };
}

/** 落一个真实临时文件，这样"失败后文件还在不在"是可测的事实而不是断言口号。 */
async function tempZip(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-accept-'));
  const absPath = join(root, 'upload.bin');
  await writeFile(absPath, 'PK\x03\x04 body');
  return absPath;
}

const intakeMock = vi.mocked(intakeUpload);
const zipMagicMock = vi.mocked(assertZipMagic);
const inspectMock = vi.mocked(inspectZip);

beforeEach(() => {
  vi.clearAllMocks();
  zipMagicMock.mockResolvedValue(undefined);
  inspectMock.mockResolvedValue({
    contentEntries: [{ compressedSize: 100, name: 'index.html', uncompressedSize: 200 }],
    entryCount: 1,
    hasRootIndex: true,
    indexCandidates: ['login-flow/index.html'],
    skipped: ['__MACOSX/._index.html'],
    totalUncompressed: 200,
  });
});

describe('受理事务与返回体（§3.0 + §5.1）', () => {
  it('新建项目+原型：返回 taskId 与访问路径，并把过渡文件换成正式名', async () => {
    const h = createHarness();
    const absPath = await tempZip();
    intakeMock.mockResolvedValue(
      intakeOf({ project: PROJECT_JSON, prototype: PROTOTYPE_JSON }, absPath),
    );

    const result = await h.service.accept(requestWith(), ACTOR, META);

    expect(result).toEqual({
      accessPath: '/p/crm/crm-p01',
      projectId: '9',
      prototypeId: '31',
      taskId: '77',
    });
    expect(h.repo.accept).toHaveBeenCalledWith(
      {
        kind: 'createProject',
        project: { code: null, description: null, name: 'CRM系统' },
        prototype: { code: null, description: null, name: '登录页演示' },
      },
      {
        createdBy: 4n,
        idempotencyKey: null,
        note: null,
        sourceName: 'login-flow.zip',
        sourceSize: 2048,
        tempKey: PENDING_KEY,
      },
    );
    // §1.2 的正式名沿用同一个随机后缀，排查时过渡名与正式名能对上。
    expect(h.storage.moveIntoService).toHaveBeenCalledWith(absPath, 'tmp/upload-77-abcd1234.zip');
    expect(h.repo.setTempKey).toHaveBeenCalledWith(77n, 'tmp/upload-77-abcd1234.zip');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'publish', module: 'proto:release' }),
    );
  });

  it('给已有原型追加版本：只带 prototypeId，不新建任何容器', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(
      intakeOf({ note: '改了配色', prototypeId: '31' }, await tempZip()),
    );

    await h.service.accept(requestWith(), ACTOR, META);

    expect(h.repo.accept).toHaveBeenCalledWith(
      { kind: 'append', prototypeId: 31n },
      expect.objectContaining({ note: '改了配色' }),
    );
    expect(h.prototypes.findAccessible).toHaveBeenCalledOnce();
  });

  it('轻校验不过时不落任何库记录，半截文件当场删掉（M3-T2 判据）', async () => {
    const h = createHarness();
    const absPath = await tempZip();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, absPath));
    zipMagicMock.mockRejectedValue(
      new BusinessException('文件不是有效的 zip 格式', ERROR_CODES.UPLOAD_NOT_ZIP, 400),
    );

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.UPLOAD_NOT_ZIP,
      httpStatus: 400,
    });
    expect(h.repo.accept).not.toHaveBeenCalled();
    expect(h.storage.moveIntoService).not.toHaveBeenCalled();
    await expect(access(absPath, constants.F_OK)).rejects.toThrow();
  });

  it('zip 里没有 index.html → 422 UPLOAD_MISSING_ENTRY，同样一条库记录都不落', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));
    inspectMock.mockResolvedValue({
      contentEntries: [{ compressedSize: 100, name: 'login-flow/readme.txt', uncompressedSize: 200 }],
      entryCount: 1,
      hasRootIndex: false,
      indexCandidates: [],
      skipped: [],
      totalUncompressed: 200,
    });

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.UPLOAD_MISSING_ENTRY,
    });
    expect(h.repo.accept).not.toHaveBeenCalled();
  });
});

describe('§2.7 同包去重', () => {
  it('与当前版本内容一致 → UPLOAD_DUPLICATE_CONTENT（HTTP 200），不建新版本', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));
    h.repo.currentSourceHash.mockResolvedValue(SOURCE_HASH);

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.UPLOAD_DUPLICATE_CONTENT,
      httpStatus: 200,
    });
    expect(h.repo.accept).not.toHaveBeenCalled();
  });

  it('force=true 时照样受理（用户明确要重发一遍）', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(
      intakeOf({ force: 'true', prototypeId: '31' }, await tempZip()),
    );
    h.repo.currentSourceHash.mockResolvedValue(SOURCE_HASH);

    await expect(h.service.accept(requestWith(), ACTOR, META)).resolves.toMatchObject({
      taskId: '77',
    });
  });

  it('新建原型没有可撞的旧版本，不去重', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(
      intakeOf({ project: PROJECT_JSON, prototype: PROTOTYPE_JSON }, await tempZip()),
    );

    await h.service.accept(requestWith(), ACTOR, META);

    expect(h.repo.currentSourceHash).not.toHaveBeenCalled();
  });
});

describe('§5.1 的 AND 权限', () => {
  it('顺带新建项目时还缺 proto:project:create → 403 指名缺的那枚码', async () => {
    const h = createHarness();
    h.permissionCodes.codesOfUser.mockResolvedValue(
      new Set(['proto:prototype:publish', 'proto:prototype:create']),
    );
    intakeMock.mockResolvedValue(
      intakeOf({ project: PROJECT_JSON, prototype: PROTOTYPE_JSON }, await tempZip()),
    );

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      httpStatus: 403,
      message: '缺少权限：proto:project:create',
    });
    expect(h.repo.accept).not.toHaveBeenCalled();
  });

  it('只追加版本时不该要求 project:create', async () => {
    const h = createHarness();
    h.permissionCodes.codesOfUser.mockResolvedValue(new Set(['proto:prototype:publish']));
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));

    await expect(h.service.accept(requestWith(), ACTOR, META)).resolves.toMatchObject({
      taskId: '77',
    });
  });

  it('超管短路，不查权限码表（C-5）', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));

    await h.service.accept(requestWith(), { ...ACTOR, isSuperAdmin: true }, META);

    expect(h.permissionCodes.codesOfUser).not.toHaveBeenCalled();
  });
});

describe('§1.5 幂等回放', () => {
  it('命中窗口内的同键：不再收文件、不再落库，直接回首次结果', async () => {
    const h = createHarness();
    h.repo.findRecentAcceptance.mockResolvedValue(ACCEPTED);

    const result = await h.service.accept(
      requestWith({ 'Idempotency-Key': 'fix-key-1' }),
      ACTOR,
      META,
    );

    expect(result).toEqual({
      accessPath: '/p/crm/crm-p01',
      projectId: '9',
      prototypeId: '31',
      taskId: '77',
    });
    expect(intakeMock).not.toHaveBeenCalled();
    expect(h.repo.accept).not.toHaveBeenCalled();
  });

  it('窗口就是 10 分钟（常量只有一处定义）', async () => {
    const h = createHarness();
    const before = Date.now();

    await h.service.accept(requestWith({ 'Idempotency-Key': 'fix-key-1' }), ACTOR, META);

    const since = h.repo.findRecentAcceptance.mock.calls[0]?.[2] as Date;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - IDEMPOTENCY_WINDOW_MS);
    expect(since.getTime()).toBeLessThanOrEqual(Date.now() - IDEMPOTENCY_WINDOW_MS);
  });

  it('没带幂等键就不查回放', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));

    await h.service.accept(requestWith(), ACTOR, META);

    expect(h.repo.findRecentAcceptance).not.toHaveBeenCalled();
  });

  it('键超长先截断再查（§1.5：报 400 会让用户以为提交失败）', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));

    await h.service.accept(requestWith({ 'Idempotency-Key': 'k'.repeat(80) }), ACTOR, META);

    expect(h.repo.accept).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'k'.repeat(64) }),
    );
  });
});

describe('目标容器的状态与编码占用', () => {
  it('追加到已下架的原型 → 400 PROTO_ARCHIVED（下架中不该收到新版本）', async () => {
    const h = createHarness();
    h.prototypes.findAccessible.mockResolvedValue(
      prototypeRow({ archivedAt: new Date(), status: 'archived' }),
    );
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: '31' }, await tempZip()));

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_ARCHIVED,
      httpStatus: 400,
    });
  });

  it('项目已归档 → 400 PROJECT_ARCHIVED', async () => {
    const h = createHarness();
    h.projects.findAccessible.mockResolvedValue(
      projectRow({ archivedAt: new Date('2026-10-05T00:00:00Z') }),
    );
    intakeMock.mockResolvedValue(
      intakeOf({ projectId: '9', prototype: PROTOTYPE_JSON }, await tempZip()),
    );

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROJECT_ARCHIVED,
      httpStatus: 400,
    });
  });

  it('手填的原型码已被占用 → 400 并带出占用者', async () => {
    const h = createHarness();
    h.prototypes.findActiveByCode.mockResolvedValue({ id: 32n, name: '别人的原型' });
    intakeMock.mockResolvedValue(
      intakeOf(
        {
          projectId: '9',
          prototype: JSON.stringify({ code: 'crm-p01', name: '登录页演示' }),
        },
        await tempZip(),
      ),
    );

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PROTO_SLUG_DUPLICATED,
      httpStatus: 400,
      message: '编码「crm-p01」已被项目「crm」下的原型「别人的原型」占用，请换一个',
    });
  });

  it('prototypeId 不是数字 → 400 的 parseIdParam 话术', async () => {
    const h = createHarness();
    intakeMock.mockResolvedValue(intakeOf({ prototypeId: 'abc' }, await tempZip()));

    await expect(h.service.accept(requestWith(), ACTOR, META)).rejects.toMatchObject({
      errorCode: ERROR_CODES.PARAM_INVALID,
      httpStatus: 400,
      message: '原型 id 必须是数字（收到的值：abc）',
    });
  });
});

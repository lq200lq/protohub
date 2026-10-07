import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  IDEMPOTENCY_KEY_HEADER,
  type ReleaseAcceptedResult,
  type ReleaseLinkPreviewResult,
} from '@protohub/shared';
import { rm } from 'node:fs/promises';

import { accessUrlOf, prototypeAccessPath } from '../../common/access-path';
import {
  assertProjectCodeFormat,
  assertPrototypeCodeFormat,
  projectCodeTakenError,
  prototypeCodeTakenError,
} from '../../common/code-feedback';
import { toActorScope } from '../../common/data-scope';
import {
  BusinessException,
  ForbiddenBusinessException,
} from '../../common/exception/business.exception';
import { readRequestHeader, type HttpRequestLike } from '../../common/http-types';
import { PermissionCodeService } from '../../common/permission/permission-code.service';
import { AppEnvService } from '../../config/app-env.service';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_WINDOW_MS,
} from '../../config/constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../storage/storage.adapter';
import { uploadTempKey } from '../storage/storage-keys';
import type { Actor, RequestMeta } from '../system/common/actor';
import { parseIdParam } from '../system/common/dto';
import { OperationAuditWriter } from '../system/audit/operation-audit.writer';
import { ProjectRepo } from '../project/project.repo';
import { PrototypeRepo } from '../prototype/prototype.repo';
import { intakeUpload, type IntakeResult, type MultipartRequestLike } from './pipeline/intake';
import {
  uploadLimitsOf,
  uploadRejected,
  type UploadLimits,
} from './pipeline/errors';
import { assertInspectable, assertZipMagic, inspectZip } from './pipeline/validate';
import {
  resolveUploadForm,
  type PublishTarget,
  type ReleaseUploadInput,
} from './release.dto';
import {
  type AcceptInput,
  type AcceptedRelease,
  type AcceptRef,
  type AcceptTarget,
  ReleaseRepo,
} from './release.repo';

/** 控制器传进来的请求视图：既要能读头（幂等键），又要能当 multipart 流消费。 */
export interface ReleaseRequest extends HttpRequestLike, MultipartRequestLike {}

/** §5.1 的权限：发布是基线，顺带新建时再各加一枚——这是 AND 关系，Guard 的 OR 语义装不下。 */
const PUBLISH_PERMISSION = 'proto:prototype:publish';
const PROJECT_CREATE_PERMISSION = 'proto:project:create';
const PROTOTYPE_CREATE_PERMISSION = 'proto:prototype:create';

/**
 * 上传受理（后端接口设计 §5.1 + 机制 §2.1 ①/§3.0）。
 *
 * 顺序就是契约，逐条对应 §5.1 的"行为"一句：
 * 1. **幂等回放先看头**（§1.5）：命中就直接回首次结果，连文件都不再收一遍——
 *    双击提交要重传 100MB 才算"幂等"是没有意义的。
 * 2. `intakeUpload` 流式落盘 + 算 sha256。
 * 3. 表单/权限/范围/编码占用：**任何一条不过都还没有库记录**（计划 M3-T2 的判据）。
 * 4. zip 轻校验（魔数 → 中央目录 → 入口存在），不过回 4xx。
 * 5. §2.7 去重：同包重传回 `UPLOAD_DUPLICATE_CONTENT`（HTTP 200，不建新版本），`force` 才继续。
 * 6. §3.0 事务落库 → rename 成 §1.2 的正式临时名 → 回填 temp_key → 202。
 *
 * 解压/改写一律不在这里（§5.2：耗时不可控会撞网关超时），交给 Worker（M3-T4）。
 */
@Injectable()
export class ReleaseService {
  constructor(
    private readonly repo: ReleaseRepo,
    private readonly projects: ProjectRepo,
    private readonly prototypes: PrototypeRepo,
    private readonly audit: OperationAuditWriter,
    private readonly appEnv: AppEnvService,
    private readonly permissionCodes: PermissionCodeService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async accept(
    request: ReleaseRequest,
    actor: Actor,
    meta: RequestMeta,
  ): Promise<ReleaseAcceptedResult> {
    const limits = uploadLimitsOf(this.appEnv.env.upload);
    const rawKey = readRequestHeader(request, IDEMPOTENCY_KEY_HEADER)?.trim() ?? '';
    const idempotencyKey =
      rawKey === '' ? null : rawKey.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH);

    const replay = await this.replay(idempotencyKey, actor);
    if (replay) {
      return replay;
    }

    const upload = await intakeUpload(request, this.storage, limits);
    try {
      return await this.acceptUpload(upload, actor, meta, limits, idempotencyKey);
    } catch (error: unknown) {
      // 受理没走完 = 库里没有引用它的行，半截文件必须当场清掉（GC 只兜进程崩溃那种）。
      await rm(upload.absPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 发布前的链接预览（接口设计 §5.9；为什么要单开这条只读接口见迭代实施计划 §9.2 DEV-20）。
   *
   * 抽屉要实时显示"发布后访问链接"这整条 URL，而域名的拼装权在服务端（§4.3 的 `accessUrl` 口径）：
   * 让前端自己拼就等于把 `PUBLIC_BASE_URL` 复制一份进浏览器代码，改了 env 会出现"界面与真实链接不一致"。
   * 预览不查库、不落库：它回答的是"这两段编码会拼成哪条链接"，唯一性由 check-code 与受理阶段各自负责。
   */
  linkPreview(
    projectCode: string,
    prototypeCode: string,
  ): ReleaseLinkPreviewResult {
    const project = projectCode.trim();
    const prototype = prototypeCode.trim();
    assertProjectCodeFormat(project);
    assertPrototypeCodeFormat(prototype);
    const accessPath = prototypeAccessPath(project, prototype);
    return {
      accessPath,
      accessUrl: accessUrlOf(this.appEnv.env.http.publicBaseUrl, accessPath),
    };
  }

  private async acceptUpload(
    upload: IntakeResult,
    actor: Actor,
    meta: RequestMeta,
    limits: UploadLimits,
    idempotencyKey: string | null,
  ): Promise<ReleaseAcceptedResult> {
    const form = resolveUploadForm(upload.fields, idempotencyKey ?? undefined);
    await this.assertPermissions(actor, form.target);

    const scope = toActorScope(actor);
    const resolved = await this.resolveTarget(form, scope);

    await assertZipMagic(upload.absPath, limits);
    const inspection = await inspectZip(upload.absPath, limits);
    assertInspectable(inspection, upload.sourceSize, limits);

    // §2.7：只在"已有原型"时才可能撞当前版本；新建的原型没有可撞的旧版本。
    if (
      resolved.prototypeIdForDedup !== null &&
      !form.force &&
      (await this.repo.currentSourceHash(resolved.prototypeIdForDedup)) === upload.sourceHash
    ) {
      throw uploadRejected(ERROR_CODES.UPLOAD_DUPLICATE_CONTENT, limits);
    }

    const input: AcceptInput = {
      createdBy: BigInt(actor.userId),
      idempotencyKey: form.idempotencyKey,
      note: form.note,
      sourceName: upload.sourceName,
      sourceSize: upload.sourceSize,
      tempKey: upload.pendingKey,
    };
    const accepted = await this.repo.accept(resolved.target, input);
    await this.confirmTempFile(upload, accepted.taskId);

    await this.audit.record({
      actor,
      action: 'publish',
      detail: {
        acceptedTaskId: accepted.taskId.toString(),
        mode: form.target.kind,
        sourceName: upload.sourceName,
        sourceSize: upload.sourceSize,
      },
      module: 'proto:release',
      request: meta,
      resourceId: accepted.prototypeId.toString(),
      resourceName: resolved.prototypeName,
      resourceType: 'prototype',
    });
    return toAcceptedResult(accepted);
  }

  /**
   * §5.1 的 AND 权限。`@RequirePermission` 是"满足任一"（Guard 的实现），
   * 而"新建项目时额外要求 `proto:project:create`"是叠加条件，只能在业务层判：
   * 这里缺的是**哪一枚**码必须说清楚，否则用户只会看到一句没有指向的 403。
   */
  private async assertPermissions(actor: Actor, target: PublishTarget): Promise<void> {
    const required = [PUBLISH_PERMISSION];
    if (target.kind === 'createProject') {
      required.push(PROJECT_CREATE_PERMISSION, PROTOTYPE_CREATE_PERMISSION);
    } else if (target.kind === 'createPrototype') {
      required.push(PROTOTYPE_CREATE_PERMISSION);
    }
    if (actor.isSuperAdmin) {
      // C-5：超管短路，不查权限码表（与 Guard 同一口径）。
      return;
    }
    const owned = await this.permissionCodes.codesOfUser(actor.userId);
    const missing = required.filter((code) => !owned.has(code));
    if (missing.length > 0) {
      throw new ForbiddenBusinessException(
        `缺少权限：${missing.join(' 与 ')}`,
        ERROR_CODES.AUTH_FORBIDDEN,
      );
    }
  }

  /**
   * 把"表单里的三种场景"换成"库里可用的目标"：范围校验（§6.2 一律问父项目）+ 归档判定 + 手填编码占用预查。
   *
   * 归档为什么也要拦（§5.1 没写，§5.5 回滚写了）：访问决策里归档就是不可访问（机制 §5.1 ②③），
   * 往一个已经下架的容器里发新版本，用户拿到的是一条打不开的链接；同一条规则不该在两处口径不一。
   */
  private async resolveTarget(
    form: ReleaseUploadInput,
    scope: ReturnType<typeof toActorScope>,
  ): Promise<{
    prototypeIdForDedup: bigint | null;
    prototypeName: string;
    target: AcceptTarget;
  }> {
    const target = form.target;
    if (target.kind === 'append') {
      const prototypeId = parseIdParam(target.prototypeId, '原型 id');
      const prototype = await this.prototypes.findAccessible(prototypeId, scope);
      if (prototype.status === 'archived') {
        throw new BusinessException(
          '该原型已下架，请先恢复上架再发布新版本',
          ERROR_CODES.PROTO_ARCHIVED,
          400,
        );
      }
      const project = await this.projects.findAccessible(prototype.projectId, scope);
      assertProjectActive(project.archivedAt);
      return {
        prototypeIdForDedup: prototype.id,
        prototypeName: prototype.name,
        target: { kind: 'append', prototypeId: prototype.id },
      };
    }

    if (target.kind === 'createPrototype') {
      const projectId = parseIdParam(target.projectId, '项目 id');
      const project = await this.projects.findAccessible(projectId, scope);
      assertProjectActive(project.archivedAt);
      const code = refCode(target.prototype.code);
      if (code !== null) {
        assertPrototypeCodeFormat(code);
        const taken = await this.prototypes.findActiveByCode(projectId, code);
        if (taken) {
          throw prototypeCodeTakenError(project.code, code, taken.name);
        }
      }
      return {
        prototypeIdForDedup: null,
        prototypeName: target.prototype.name,
        target: {
          kind: 'createPrototype',
          projectId,
          prototype: toAcceptRef(target.prototype, code),
        },
      };
    }

    const code = refCode(target.project.code);
    if (code !== null) {
      assertProjectCodeFormat(code);
      const taken = await this.projects.findActiveByCode(code);
      if (taken) {
        throw projectCodeTakenError(taken.name);
      }
    }
    const prototypeCode = refCode(target.prototype.code);
    if (prototypeCode !== null) {
      assertPrototypeCodeFormat(prototypeCode);
    }
    // 全新项目下不可能已有同名原型，所以原型码这里不需要预查；唯一索引仍然兜得住。
    return {
      prototypeIdForDedup: null,
      prototypeName: target.prototype.name,
      target: {
        kind: 'createProject',
        project: toAcceptRef(target.project, code),
        prototype: toAcceptRef(target.prototype, prototypeCode),
      },
    };
  }

  /** §1.5：命中就回首次结果。同人同键才算同一个请求，否则 A 的键会吃掉 B 的任务。 */
  private async replay(
    idempotencyKey: string | null,
    actor: Actor,
  ): Promise<ReleaseAcceptedResult | null> {
    if (idempotencyKey === null) {
      return null;
    }
    const hit = await this.repo.findRecentAcceptance(
      BigInt(actor.userId),
      idempotencyKey,
      new Date(Date.now() - IDEMPOTENCY_WINDOW_MS),
    );
    return hit === null ? null : toAcceptedResult(hit);
  }

  /**
   * 事务成功后才把过渡名换成 §1.2 的正式名（`tmp/upload-{taskId}-{random}.zip`）。
   *
   * 先 rename 再回填 key：反过来的话崩溃点会留下"库里指向正式名、磁盘上还是过渡名"的
   * 任务，Worker 只能判失败；现在的最坏情况是"磁盘上有个没人引用的过渡文件"，GC 扫得掉（§3.1
   * 的取向）。见计划 §9 DEV-17。
   */
  private async confirmTempFile(
    upload: IntakeResult,
    taskId: bigint,
  ): Promise<void> {
    const finalKey = uploadTempKey(taskId.toString(), upload.random);
    await this.storage.moveIntoService(upload.absPath, finalKey);
    await this.repo.setTempKey(taskId, finalKey);
  }
}

function toAcceptedResult(row: AcceptedRelease): ReleaseAcceptedResult {
  return {
    accessPath: prototypeAccessPath(row.projectCode, row.prototypeCode),
    projectId: row.projectId.toString(),
    prototypeId: row.prototypeId.toString(),
    taskId: row.taskId.toString(),
  };
}

function assertProjectActive(archivedAt: Date | null): void {
  if (archivedAt !== null) {
    throw new BusinessException(
      '该项目已归档，先恢复项目再发布',
      ERROR_CODES.PROJECT_ARCHIVED,
      400,
    );
  }
}

/** '' 与缺省都算"帮我生成"（D-20），所以统一收敛成 null。 */
function refCode(code: string | undefined): string | null {
  const value = code?.trim() ?? '';
  return value === '' ? null : value;
}

function toAcceptRef(
  ref: { description?: string; name: string },
  code: string | null,
): AcceptRef {
  return { code, description: ref.description ?? null, name: ref.name };
}

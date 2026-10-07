import { rm, writeFile } from 'node:fs/promises';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ERROR_CODES } from '@protohub/shared';

import { isUniqueViolation } from '../../../common/db-error';
import { BusinessException } from '../../../common/exception/business.exception';
import {
  RELEASE_COMMIT_TX_TIMEOUT_MS,
  RELEASE_VERSION_MAX_RETRY,
} from '../../../config/constants';
import { PRISMA_CLIENT } from '../../system/persistence/prisma-token';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../storage/storage.adapter';
import { manifestKey, releaseKey } from '../../storage/storage-keys';
import type { ReleaseManifest } from './postprocess';

/**
 * 提交（机制 §3.1「先落盘、后写库」+ §3.2 并发）。流水线到这里收尾：
 * 工作目录里已经躺着一批改写完毕、算好指纹的产物，这一步把它变成"一条能被访问的版本"。
 *
 * 事务内的顺序就是 §3.1 那张单子，一条都不能换（计划 M3-T8 的判据是"顺序不能反"）：
 *
 * ```
 * a. SELECT … FROM proto_prototype WHERE id = ? FOR UPDATE   （锁住原型行 = 串行化同一原型的取号）
 * b. version_no = COALESCE(max(version_no), 0) + 1
 * c. INSERT proto_release RETURNING id                        （storage_key 先写父前缀）
 *    → rename tmp/work-{taskId} → releases/{pid}/{protoId}/{rid}   （§3.1 第 2 步）
 *    → 清单副本 manifests/{protoId}/{rid}.json                    （§2.7）
 * d. UPDATE proto_release SET storage_key                        （回填 §1.2 的完整 key）
 * e. UPDATE proto_prototype 切指针
 * f. INSERT proto_release_event(publish)
 * ```
 *
 * **c 为什么拆成"先插前缀、后回填"**：§1.2 的 key 里含 `releaseId`，而它是自增主键——
 * 只有 `INSERT` 之后才知道。§3.1 明确给了这条路（"先 INSERT 拿到 id，再 rename，最后回填"），
 * 并且禁止另一条省事的路（用 `max(id)+1` 猜 id，并发下必撞）。猜出来的 id 会让两条发布
 * 抢同一个目录名，而真实自增 id 永不回退，所以重试也不会撞上自己上一次留下的目录。
 *
 * **rename 为什么在指针切换之前**：反过来最坏是"指针指向不存在的目录"= 访问直接 404 且无自愈路径；
 * 现在最坏是"磁盘上有个没被任何记录引用的目录"= GC 的孤儿检测收走（§4.3）。
 * 故障模式优先选可自愈的那种（§3.1 原文的取向）。
 *
 * **落盘为什么留在事务里而不是挪到提交之后**：这决定了失败的形状。事务内失败 = 整笔回滚 =
 * 任务如实报失败（磁盘满就是 `UPLOAD_DISK_FULL`）；挪到提交后失败 = 磁盘没东西而库里已经宣称成功 =
 * 用户点开一条 404 链接，正是本层要避免的那一种。至于回滚后留下的孤儿目录，机制 §4.3 第⑥步
 * 本来就为它准备了回收规则。
 */

export interface CommitInput {
  /** §2.7 产物指纹（postprocess 的返回值，打在改写后的字节上） */
  readonly contentHash: string;
  readonly createdBy: bigint;
  /** 入口文件在工作目录内的相对路径（§2.5 的判定结果） */
  readonly entry: string;
  readonly manifest: ReleaseManifest;
  /** 版本说明，来自任务行（§3.0：受理时就定下、Worker 唯一能读到的输入） */
  readonly note: string | null;
  readonly projectId: bigint;
  readonly prototypeId: bigint;
  /** 上传 zip 的 sha256（§2.7 的去重依据，受理时算好） */
  readonly sourceHash: string;
  readonly sourceSize: number;
  /** `tmp/work-{taskId}` 的绝对路径；成功后它就不存在了（被 rename 走）。 */
  readonly workDir: string;
}

export interface CommitResult {
  readonly releaseId: bigint;
  readonly storageKey: string;
  readonly versionNo: number;
}

/**
 * §3.2「发布过程中原型/项目被删除 → 任务失败 `PROTO_NOT_FOUND` 并清理 tmp」。
 *
 * 刻意不是 `BusinessException`：那条是 HTTP 层的形状（带 httpStatus、进响应体），而这里是 Worker
 * 内部的控制流——它要把同一句话写进 `proto_upload_task.error_code`，并顺手删掉临时 zip。
 */
export class PrototypeDeletedError extends Error {
  readonly code = ERROR_CODES.PROTO_NOT_FOUND;

  constructor(readonly prototypeId: bigint) {
    super(`原型 ${String(prototypeId)} 已被删除，本次发布终止`);
    this.name = 'PrototypeDeletedError';
  }
}

/** `FOR UPDATE` 一次性取回的两列：在不在（软删）+ 上一版是谁（事件的 from）。 */
interface LockedPrototype {
  current_release_id: bigint | null;
  deleted_at: Date | null;
}

@Injectable()
export class ReleaseCommitter {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  /**
   * §3.2 的第一行：同一原型并发发布由 `FOR UPDATE` 串行化；万一漏了，
   * `uk_proto_release_version` 兜底并在这里重试整个事务（最多 `RELEASE_VERSION_MAX_RETRY` 次）。
   *
   * 重试单位是事务而不是语句：PG 里一条语句失败就废掉当前事务（同 §3.0 的理由）。
   * 非撞码错误原样上抛——`PrototypeDeletedError` 和磁盘错误都不是"再试一次"能解决的。
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    for (let attempt = 1; attempt <= RELEASE_VERSION_MAX_RETRY; attempt += 1) {
      try {
        return await this.commitOnce(input);
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    throw new BusinessException(
      `同一原型连续 ${String(RELEASE_VERSION_MAX_RETRY)} 次抢版本号失败，请稍后重新发布`,
      ERROR_CODES.UPLOAD_WORKER_FAILED,
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private async commitOnce(input: CommitInput): Promise<CommitResult> {
    // jsonb 与磁盘副本用同一串字节：序列化两次会让"清单与库里的对不上账"成为可能。
    const manifestJson = JSON.stringify(input.manifest);
    return this.db.$transaction(
      async (client) => {
        const locked = await this.lockPrototype(client, input.prototypeId);
        const versionNo = await nextVersionNo(client, input.prototypeId);
        const releaseId = await insertRelease(client, input, versionNo, manifestJson);

        // key 的三段 ID 只可能是十进制；不合法时 storage-keys 会直接抛，不会拼出越界路径。
        const storageKey = releaseKey(
          String(input.projectId),
          String(input.prototypeId),
          String(releaseId),
        );
        await this.storage.moveIntoService(input.workDir, storageKey);
        await this.writeManifestCopy(input, manifestJson, releaseId);

        await client.protoRelease.update({ data: { storageKey }, where: { id: releaseId } });
        await switchCurrentRelease(client, input, releaseId);
        await client.protoReleaseEvent.create({
          data: {
            eventType: 'publish',
            fromReleaseId: locked.current_release_id,
            operatorId: input.createdBy,
            prototypeId: input.prototypeId,
            reason: input.note,
            toReleaseId: releaseId,
          },
          select: { id: true },
        });
        return { releaseId, storageKey, versionNo };
      },
      { timeout: RELEASE_COMMIT_TX_TIMEOUT_MS },
    );
  }

  /**
   * §3.1 a：锁原型行 + 确认它还在。
   * 删除先完成 → `deleted_at` 非空（或行已被级联物理删掉）→ 本次发布终止；
   * 删除正在等这把锁 → 我们拿到的是"还没删"的行，删的人随后看见的是新版本，两边都不脏。
   */
  private async lockPrototype(
    client: Prisma.TransactionClient,
    prototypeId: bigint,
  ): Promise<LockedPrototype> {
    const rows = await client.$queryRaw<Array<LockedPrototype>>`
      select deleted_at, current_release_id
      from proto_prototype
      where id = ${prototypeId}
      for update`;
    const row = rows[0];
    if (row === undefined || row.deleted_at !== null) {
      throw new PrototypeDeletedError(prototypeId);
    }
    return row;
  }

  /**
   * 清单副本（§2.7）：库里那份 jsonb 是权威，磁盘上再留一份给运维直接看与对账。
   *
   * 源文件写在 `tmp/work-{taskId}.manifest.json`（工作目录的同级兄弟名）——`putFile()` 要一个
   * 本地路径，而工作目录本身马上要整个 rename 进 `releases/`，不能提前往里面塞不发布的东西。
   * 用完即删；崩在中间留下的那份归 §4.3 的 tmp 规则（超 24 小时一律删）。
   */
  private async writeManifestCopy(
    input: CommitInput,
    manifestJson: string,
    releaseId: bigint,
  ): Promise<void> {
    const tempPath = `${input.workDir}.manifest.json`;
    try {
      await writeFile(tempPath, manifestJson, 'utf8');
      await this.storage.putFile(
        tempPath,
        manifestKey(String(input.prototypeId), String(releaseId)),
      );
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * §3.1 b：原型内递增取号。
 * 号在锁里读，所以两条并发发布不可能算出同一个 `version_no`；`coalesce` 对应首个版本（无历史行）。
 */
async function nextVersionNo(
  client: Prisma.TransactionClient,
  prototypeId: bigint,
): Promise<number> {
  const rows = await client.$queryRaw<Array<{ next: number }>>`
    select coalesce(max(version_no), 0) + 1 as next
    from proto_release
    where prototype_id = ${prototypeId}`;
  const row = rows[0];
  if (row === undefined) {
    // 聚合查询恒有一行；真没有就是驱动行为变了，宁可停下也不猜一个号。
    throw new Error('取版本号未返回结果');
  }
  return row.next;
}

/**
 * §3.1 c：插版本行拿 `releaseId`。
 *
 * 走裸 SQL 而不是查询构造器：要 `RETURNING id`（拿到 id 才能定 key），又要在插入时就让
 * `storage_key` 非空（列是 NOT NULL），而完整的 key 此刻还算不出来——所以先写该 release 的
 * **父前缀**，rename 完成后回填成完整 key（§3.1 的"回填"一步）。
 * 中间态的 key 不是可访问路径，也不会被读到：这条 INSERT 提交之前没人看得见它。
 */
async function insertRelease(
  client: Prisma.TransactionClient,
  input: CommitInput,
  versionNo: number,
  manifestJson: string,
): Promise<bigint> {
  const prefix = `releases/${String(input.projectId)}/${String(input.prototypeId)}/`;
  const rows = await client.$queryRaw<Array<{ id: bigint }>>`
    insert into proto_release (
      prototype_id, version_no, status, storage_key, entry_file,
      source_hash, content_hash, source_size, file_count, total_bytes,
      manifest, note, created_by
    ) values (
      ${input.prototypeId}, ${versionNo}, 'ready', ${prefix}, ${input.entry},
      ${input.sourceHash}, ${input.contentHash}, ${BigInt(input.sourceSize)},
      ${input.manifest.fileCount}, ${BigInt(input.manifest.totalBytes)},
      ${manifestJson}::jsonb, ${input.note}, ${input.createdBy}
    )
    returning id`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error('插入版本记录未返回 id');
  }
  return row.id;
}

/**
 * §3.1 d：切当前版本指针 + 生效时间。
 *
 * 裸 SQL 只为两个表达式：
 * - `first_published_at = coalesce(first_published_at, now())`——"首次上线时间"只在第一次发布时
 *   落下，之后永不改动；而 `published_at` 每次生效都前进（§4.2 特意区分这两个字段，别混用）。
 *   读出来再写回去是两步，两步之间可以是别人的提交；写在 SQL 里就只有一次判定。
 * - `status` 的那句 `case`：归档（=已下架）不因一次发布而被悄悄翻回 `published`。
 *   §5.1 在受理时就以 `PROTO_ARCHIVED` 拒绝向归档原型发布，而受理与提交之间隔着队列——
 *   异步间隙不该变成同一条规则的绕行通道（访问决策 §5.3 读的就是这个 status）。
 *
 * 循环外键 `fk_proto_prototype_current_release` 要求版本行已存在：指针指向的正是本事务第 c 步插的那行。
 */
async function switchCurrentRelease(
  client: Prisma.TransactionClient,
  input: CommitInput,
  releaseId: bigint,
): Promise<void> {
  await client.$executeRaw`
    update proto_prototype
    set current_release_id = ${releaseId},
        status = case when status = 'archived' then status else 'published' end,
        published_at = now(),
        first_published_at = coalesce(first_published_at, now()),
        updated_at = now(),
        updated_by = ${input.createdBy}
    where id = ${input.prototypeId}`;
}

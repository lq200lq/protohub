import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PrismaClient } from '@prisma/client';

import { statfs } from 'node:fs/promises';

import { AppEnvService } from '../../config/app-env.service';
import {
  STORAGE_ADAPTER,
  StorageObjectMissingError,
  type StorageAdapter,
} from '../storage/storage.adapter';
import { RELEASES_PREFIX, TMP_PREFIX, TRASH_PREFIX } from '../storage/storage-keys';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 垃圾回收（[原型发布与访问机制.md](../../../../docs/原型发布与访问机制.md) §4.3；迭代实施计划 M5-T6）。
 *
 * 七步顺序就是机制 §4.3 那张图，每一步都**基于当前 DB/磁盘状态推导**，不带上次的游标：
 * ① 到期任务记录（`TASK_KEEP_DAYS`）→ ② 到期日志（`ACCESS_LOG_KEEP_DAYS`）→ ③ 可回收版本标记 `deleted` →
 * ④ `trash/` 里满 7 天的物理删除 → ⑤ 标记满 7 天的版本移入 `trash/` → ⑥ 孤儿目录 → ⑦ summary。
 *
 * **幂等且可中断**：⑤ 要动的目录可能上一轮已经移走了，`moveToTrash` 抛"对象不存在"就是
 * 已经做过，跳过即可；所以中途被杀之后重跑能继续，也不会重复删除。每一步各自 try/catch，
 * 一步失败不吞掉后面几步（否则一次磁盘抖动就让整个回收停摆）。
 *
 * 三条保留规则（§4.3 表）在这里合成一个判据：当前生效版本永不删、每个**原型**保留最近
 * `KEEP_RECENT_RELEASES` 个、最近 `KEEP_MIN_DAYS` 天内的一律保留（时间兜底）。
 * 保留计数**按原型算不按项目算**——按项目算会把 20 个原型的项目挤到几乎无版本可回滚。
 */
const DAY_MS = 86_400_000;

/** 孤儿目录的最小年龄：给"先 rename 到 releases、再写库"（§3.1）留出的一小时窗口。 */
const ORPHAN_MIN_AGE_MS = 3_600_000;

/** `tmp/**` 残留：超过 24 小时的工作目录与上传包（§4.3）。 */
const TMP_MAX_AGE_MS = 86_400_000;

/** 每轮 GC 的 summary（⑦）：删除目录数、释放字节数、当前磁盘余量 + 各步计数。 */
export interface GcSummary {
  bytesFreed: number;
  dirsRemoved: number;
  freeDiskBytes: null | number;
  logsDeleted: number;
  markedDeleted: number;
  movedToTrash: number;
  orphansMovedToTrash: number;
  startedAt: string;
  tasksDeleted: number;
  tmpRemoved: number;
}

@Injectable()
export class GcService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(GcService.name);
  private startupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PRISMA_CLIENT) private readonly db: PrismaClient,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly env: AppEnvService,
  ) {}

  /** 每天 03:30（§4.3） */
  @Cron('30 3 * * *')
  async scheduledRun(): Promise<void> {
    await this.runOnce();
  }

  /** 服务启动 5 分钟后跑一次（§4.3），让长期不重启的实例也能跟上 */
  onModuleInit(): void {
    this.startupTimer = setTimeout(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error(`启动期 GC 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 5 * 60_000);
  }

  onModuleDestroy(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /** 跑一轮完整的回收；每步独立容错，返回值就是 summary 日志那三项 + 各步计数。 */
  async runOnce(): Promise<GcSummary> {
    const startedAt = Date.now();
    const summary: GcSummary = {
      bytesFreed: 0,
      dirsRemoved: 0,
      freeDiskBytes: null,
      logsDeleted: 0,
      markedDeleted: 0,
      movedToTrash: 0,
      orphansMovedToTrash: 0,
      startedAt: new Date(startedAt).toISOString(),
      tasksDeleted: 0,
      tmpRemoved: 0,
    };

    await this.step('① 到期任务记录', async () => {
      summary.tasksDeleted = await this.purgeTasks(startedAt);
    });
    await this.step('② 到期日志', async () => {
      summary.logsDeleted = await this.purgeLogs(startedAt);
    });
    await this.step('③ 可回收版本', async () => {
      summary.markedDeleted = await this.markReclaimable(startedAt);
    });
    await this.step('④ trash 到期', async () => {
      await this.purgeTrash(startedAt, summary);
    });
    await this.step('⑤ deleted 过期移入 trash', async () => {
      summary.movedToTrash = await this.moveExpiredDeletedToTrash(startedAt);
    });
    await this.step('⑥ 孤儿目录', async () => {
      summary.orphansMovedToTrash = await this.moveOrphansToTrash(startedAt);
    });
    // §4.3 的七步里没有编号这一步，但规则表里有"tmp 残留清理"；这里与孤儿目录同批做
    await this.step('tmp 残留', async () => {
      await this.purgeTmp(startedAt, summary);
    });
    await this.step('⑦ summary', async () => {
      summary.freeDiskBytes = await this.freeDiskBytes();
    });

    this.logger.log(
      `GC 完成：删目录 ${summary.dirsRemoved} 个 · 释放 ${summary.bytesFreed} 字节 · ` +
        `磁盘余量 ${summary.freeDiskBytes === null ? '未知' : String(summary.freeDiskBytes)} 字节 · ` +
        `标记 deleted ${summary.markedDeleted} · 移入 trash ${summary.movedToTrash + summary.orphansMovedToTrash} · ` +
        `tmp ${summary.tmpRemoved} · 任务 ${summary.tasksDeleted} · 日志 ${summary.logsDeleted}`,
    );
    return summary;
  }

  /** 单步容错：这一步炸了要看得见，但不能把后面几步一起带走 */
  private async step(name: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error: unknown) {
      this.logger.error(
        `GC ${name} 失败（本轮继续后面的步骤，下次重跑）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async purgeTasks(now: number): Promise<number> {
    const cutoff = new Date(now - this.env.env.retention.taskKeepDays * DAY_MS);
    const result = await this.db.protoUploadTask.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }

  private async purgeLogs(now: number): Promise<number> {
    const cutoff = new Date(now - this.env.env.retention.accessLogKeepDays * DAY_MS);
    const access = await this.db.protoAccessLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    const login = await this.db.sysLoginLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    const oper = await this.db.sysOperLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return access.count + login.count + oper.count;
  }

  /**
   * ③ 逐原型选出可回收版本 → `status='deleted'` + `deletedAt=now`。
   * 三条规则一次判：当前生效版本永不删、按原型保留最近 N 个、最近 M 天内一律保留。
   */
  private async markReclaimable(now: number): Promise<number> {
    const { keepMinDays, keepRecentReleases } = this.env.env.release;
    const releases = await this.db.protoRelease.findMany({
      orderBy: [{ prototypeId: 'asc' }, { versionNo: 'desc' }],
      select: { createdAt: true, id: true, prototypeId: true },
      where: { deletedAt: null },
    });
    const currentIds = new Set(
      (
        await this.db.protoPrototype.findMany({
          select: { currentReleaseId: true },
          where: { currentReleaseId: { not: null } },
        })
      ).map((row) => String(row.currentReleaseId)),
    );

    const reclaimable: bigint[] = [];
    let seenInPrototype = 0;
    let previousPrototype = '';
    for (const release of releases) {
      const prototype = String(release.prototypeId);
      if (prototype !== previousPrototype) {
        previousPrototype = prototype;
        seenInPrototype = 0;
      }
      seenInPrototype += 1;
      if (currentIds.has(String(release.id))) continue;
      if (seenInPrototype <= keepRecentReleases) continue;
      if (release.createdAt.getTime() >= now - keepMinDays * DAY_MS) continue;
      reclaimable.push(release.id);
    }
    if (reclaimable.length === 0) return 0;
    const result = await this.db.protoRelease.updateMany({
      data: { deletedAt: new Date(now), status: 'deleted' },
      where: { id: { in: reclaimable } },
    });
    return result.count;
  }

  /** ④ `trash/` 里满 N 天的目录 → 物理删除 */
  private async purgeTrash(now: number, summary: GcSummary): Promise<void> {
    const ttlMs = this.env.env.release.trashTtlDays * DAY_MS;
    for (const entry of await this.storage.listPrefix(TRASH_PREFIX)) {
      if (entry.mtimeMs >= now - ttlMs) continue;
      await this.storage.deletePrefix(entry.key);
      summary.dirsRemoved += 1;
      summary.bytesFreed += entry.sizeBytes;
    }
  }

  /**
   * ⑤ 标记满 N 天的 deleted 版本 → 移入 `trash/`。
   * 目录不在了（上一轮已经移过）就是已完成，跳过——这就是幂等的来源。
   */
  private async moveExpiredDeletedToTrash(now: number): Promise<number> {
    const cutoff = new Date(now - this.env.env.release.trashTtlDays * DAY_MS);
    const rows = await this.db.protoRelease.findMany({
      select: { deletedAt: true, storageKey: true },
      where: { deletedAt: { lt: cutoff }, status: 'deleted' },
    });
    let moved = 0;
    for (const row of rows) {
      try {
        const targetKey = await this.storage.moveToTrash(row.storageKey);
        moved += 1;
        // 释放的字节数留给 ④ 物理删除那一步算，同一份空间不记两次
        this.logger.log(`版本目录移入 trash：${row.storageKey} → ${targetKey}`);
      } catch (error: unknown) {
        if (error instanceof StorageObjectMissingError) continue;
        throw error;
      }
    }
    return moved;
  }

  /** ⑥ `tmp/**` 里超过 24 小时的工作目录与上传包 */
  private async purgeTmp(now: number, summary: GcSummary): Promise<void> {
    for (const entry of await this.storage.listPrefix(TMP_PREFIX)) {
      if (entry.mtimeMs >= now - TMP_MAX_AGE_MS) continue;
      await this.storage.deletePrefix(entry.key);
      summary.dirsRemoved += 1;
      summary.tmpRemoved += 1;
      summary.bytesFreed += entry.sizeBytes;
    }
  }

  /**
   * ⑦ `releases/**` 里 DB 中不存在的 releaseId 且 mtime 超过 1 小时 → 移入 trash
   * （§3.1"先 rename 再写库"留下的垃圾在这里被回收）。
   */
  private async moveOrphansToTrash(now: number): Promise<number> {
    const knownIds = new Set(
      (await this.db.protoRelease.findMany({ select: { id: true } })).map((row) =>
        String(row.id),
      ),
    );
    let moved = 0;
    for (const project of await this.storage.listPrefix(RELEASES_PREFIX)) {
      if (!project.isDirectory) continue;
      for (const prototype of await this.storage.listPrefix(project.key)) {
        if (!prototype.isDirectory) continue;
        for (const release of await this.storage.listPrefix(prototype.key)) {
          const releaseId = release.key.split('/').pop() ?? '';
          if (knownIds.has(releaseId)) continue;
          if (release.mtimeMs >= now - ORPHAN_MIN_AGE_MS) continue;
          try {
            await this.storage.moveToTrash(release.key);
            moved += 1;
          } catch (error: unknown) {
            if (error instanceof StorageObjectMissingError) continue;
            throw error;
          }
        }
      }
    }
    return moved;
  }

  /** ⑦ 的"当前磁盘余量"；取不到（文件系统不支持）就给 null，不为它判失败 */
  private async freeDiskBytes(): Promise<null | number> {
    try {
      const info = await statfs(this.env.env.storage.root);
      return Number(info.bavail) * Number(info.bsize);
    } catch {
      return null;
    }
  }
}

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { AppEnvService } from '../../config/app-env.service';
import { STORAGE_SUBDIRS } from '../../config/constants';
import {
  requireLocalPath,
  StorageInvalidKeyError,
  StorageObjectMissingError,
  type MountpointCheck,
  type StorageAdapter,
  type StorageEntry,
} from './storage.adapter';
import { dateDirOf, parseReleaseKey, trashKeyOf } from './storage-keys';

/** 随机后缀：同一 key 并发改名时不互相覆盖（tmp 落盘与 trash 收纳都用）。 */
export function storageRandom(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

/**
 * 本地磁盘实现（决策 D-08 的 v1 唯一实现）。
 *
 * 所有 key 都被限制在 `{STORAGE_ROOT}` 之内：`localPathOf()` 是唯一把 key 变成绝对路径的地方，
 * 解析后仍做一次前缀断言——即便调用方传进来了用户输入，也逃不出根目录。
 */
@Injectable()
export class LocalStorageAdapter implements StorageAdapter, OnModuleInit {
  private readonly logger = new Logger(LocalStorageAdapter.name);
  readonly root: string;

  constructor(env: AppEnvService) {
    this.root = resolve(env.env.storage.root);
  }

  /**
   * 启动时自建目录布局，并核对 `tmp/` 与 `releases/` 在同一挂载点（计划 M3-T1 判据）。
   *
   * 跨挂载点时 `rename()` 退化成"拷贝 + 删除"，发布中途可能被读到半个目录（机制 §1.3）。
   * 这里是**告警**而不是拒绝启动：开发环境把 STORAGE_ROOT 换分区仍能跑，只是失去原子性；
   * 生产由部署检查清单的 `df` 核对项兜住（部署方案 §8）。
   */
  async onModuleInit(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const subdir of STORAGE_SUBDIRS) {
      await mkdir(join(this.root, subdir), { recursive: true });
    }
    const check = await this.checkMountpoints();
    if (check.ok) {
      this.logger.log(`存储目录布局就绪 ${check.detail}`, {
        storageRoot: this.root,
      });
      return;
    }
    this.logger.warn(
      `tmp/ 与 releases/ 不在同一文件系统，发布最后一步的 rename 不再是原子操作：${check.detail}`,
      { storageRoot: this.root },
    );
  }

  /** 取两个子目录的 `stat.dev`（设备号）比对；不一致即跨挂载点。 */
  async checkMountpoints(): Promise<MountpointCheck> {
    const tmpPath = join(this.root, 'tmp');
    const releasesPath = join(this.root, 'releases');
    for (const abs of [tmpPath, releasesPath]) {
      if (!existsSync(abs)) {
        return { detail: `目录 ${abs} 不存在`, ok: false };
      }
    }
    const tmpDev = (await stat(tmpPath)).dev;
    const releasesDev = (await stat(releasesPath)).dev;
    if (tmpDev !== releasesDev) {
      return {
        detail: `tmp dev=${String(tmpDev)}，releases dev=${String(releasesDev)}`,
        ok: false,
      };
    }
    return { detail: `tmp/ 与 releases/ 同在设备 ${String(tmpDev)}`, ok: true };
  }

  localPathOf(key: string): string | null {
    const cleaned = normalizeKey(key);
    if (cleaned === null) {
      return null;
    }
    const abs = resolve(this.root, cleaned);
    const rootWithSep = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    return abs.startsWith(rootWithSep) ? abs : null;
  }

  /** 拿不到绝对路径只可能是 key 本身不合法（本地实现不会返回 null）。 */
  requireLocalPath(key: string): string {
    return requireLocalPath(this, key);
  }

  async exists(key: string): Promise<boolean> {
    const abs = this.localPathOf(key);
    return abs !== null && existsSync(abs);
  }

  async putFile(localPath: string, key: string): Promise<void> {
    const abs = this.requireLocalPath(key);
    await mkdir(resolve(abs, '..'), { recursive: true });
    await copyFile(localPath, abs);
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const abs = this.localPathOf(key);
    if (abs === null) {
      throw new StorageInvalidKeyError(key);
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new StorageObjectMissingError(key);
    }
    if (!info.isFile()) {
      throw new StorageObjectMissingError(key);
    }
    return createReadStream(abs);
  }

  async deletePrefix(keyPrefix: string): Promise<void> {
    const abs = this.requireLocalPath(keyPrefix);
    // 递归删除必须是显式前缀：等于根目录的写法一律拒绝。
    if (abs === this.root) {
      throw new StorageInvalidKeyError(keyPrefix);
    }
    await rm(abs, { force: true, recursive: true });
  }

  /**
   * 列出某个前缀下的直接子项（GC 的三处扫描共用）：前缀不存在返回空数组而不是抛错——
   * GC 要能"基于当前状态推导"，第一次跑在空盘上就是 no-op。
   */
  async listPrefix(keyPrefix: string): Promise<StorageEntry[]> {
    const abs = this.requireLocalPath(keyPrefix);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      return [];
    }
    const prefix = keyPrefix.replace(/\/+$/, '');
    const entries: StorageEntry[] = [];
    for (const name of names) {
      const childAbs = resolve(abs, name);
      try {
        const info = await stat(childAbs);
        entries.push({
          isDirectory: info.isDirectory(),
          key: `${prefix}/${name}`,
          mtimeMs: info.mtimeMs,
          sizeBytes: info.isDirectory() ? await sizeOfTree(childAbs) : info.size,
        });
      } catch {
        // 读到一半被别人删了：跳过这一项，不中断整轮扫描
      }
    }
    return entries;
  }

  /** rename 进 `trash/{yyyyMMdd}/…` 并返回新 key（同分区，所以原子；机制 §4.3 延迟物理删除）。 */  async moveToTrash(keyPrefix: string): Promise<string> {
    const abs = this.requireLocalPath(keyPrefix);
    if (abs === this.root) {
      throw new StorageInvalidKeyError(keyPrefix);
    }
    let info;
    try {
      info = await stat(abs);
    } catch {
      throw new StorageObjectMissingError(keyPrefix);
    }
    if (!info.isDirectory()) {
      throw new StorageInvalidKeyError(keyPrefix);
    }
    const cleaned = normalizeKey(keyPrefix);
    const release = cleaned === null ? null : parseReleaseKey(cleaned);
    const name =
      release === null
        ? cleaned?.split('/').join('-') ?? ''
        : `${release.prototypeId}-${release.releaseId}`;
    const targetKey = trashKeyOf(dateDirOf(), name, storageRandom());
    const targetAbs = this.requireLocalPath(targetKey);
    await mkdir(resolve(targetAbs, '..'), { recursive: true });
    await rename(abs, targetAbs);
    return targetKey;
  }

  /** commit 第 2 步：把工作目录原子地纳入服务范围。目标已存在时失败而不是覆盖，让冲突被人看见。 */
  async moveIntoService(localPath: string, key: string): Promise<void> {
    const abs = this.requireLocalPath(key);
    if (existsSync(abs)) {
      throw new Error(`存储目标已存在，拒绝覆盖: ${key}`);
    }
    await mkdir(resolve(abs, '..'), { recursive: true });
    await rename(localPath, abs);
  }
}

/** 目录的递归字节数（GC summary 的"释放字节数"）；子项读不到就当 0，不为一个消失的文件炸掉整轮 GC。 */
async function sizeOfTree(abs: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(abs);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const info = await stat(resolve(abs, name));
      total += info.isDirectory() ? await sizeOfTree(resolve(abs, name)) : info.size;
    } catch {
      // 子项读到一半消失：不计也不中断
    }
  }
  return total;
}

/**
 * key 归一化：去前导斜杠、统一分隔符，并拒绝任何越界写法。
 * 返回 `null` 表示这个 key 根本不该被解析成路径（调用方据此拒绝，而不是猜一个路径）。
 */
function normalizeKey(key: string): string | null {
  const cleaned = key.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    cleaned === '' ||
    cleaned.includes('\0') ||
    cleaned.startsWith('.') ||
    cleaned.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return cleaned;
}

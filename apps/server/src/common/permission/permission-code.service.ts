import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';
import { PERMISSION_CODES, type PermissionCode } from '@protohub/shared';

import { TtlLruCache } from './permission-cache';
import { PRISMA_CLIENT } from './prisma-client';

/** 权限模型设计 §8.2 定的 30 秒：再短会让每个请求多一次联表查询，再长撤销会明显滞后。 */
export const PERMISSION_CACHE_TTL_MS = 30_000;

/** 进程内缓存条数上限：内部平台的并发活跃用户量级远小于此，主要是防内存无界增长。 */
export const PERMISSION_CACHE_MAX_ENTRIES = 1_000;

function toId(value: string): bigint | null {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * 权限码解析 + 30 秒 TTL 的进程内 LRU 缓存（权限模型设计 §8.2）。
 *
 * 缓存 key 是用户 ID。**主动失效**由三类写操作触发（改角色权限 / 改用户角色 / 禁用用户），
 * 方法在下面以 `invalidate*` 暴露给 system 模块调用。
 * 安全相关的撤销（禁用、改密）不走这条缓存——Guard 每次另外查 `status`/`token_version`。
 */
@Injectable()
export class PermissionCodeService {
  private readonly cache = new TtlLruCache<ReadonlySet<string>>(
    PERMISSION_CACHE_TTL_MS,
    PERMISSION_CACHE_MAX_ENTRIES,
  );

  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  async codesOfUser(userId: string): Promise<ReadonlySet<string>> {
    const cached = this.cache.get(userId);
    if (cached) {
      return cached;
    }
    const codes = await this.loadFromDb(userId);
    this.cache.set(userId, codes);
    return codes;
  }

  /** `/auth/codes` 与前端按钮判断用；数组顺序稳定（按 PERMISSIONS 常量顺序），便于快照断言。 */
  async codeList(userId: string, superAdmin: boolean): Promise<PermissionCode[]> {
    if (superAdmin) {
      // C-5：超管直接给全集，避免"自己把权限改坏后连按钮都看不见"。
      return [...PERMISSION_CODES];
    }
    const codes = await this.codesOfUser(userId);
    return PERMISSION_CODES.filter((code) => codes.has(code));
  }

  async invalidateUser(userId: string): Promise<void> {
    this.cache.delete(userId);
  }

  /** 改角色权限后调用：该角色下所有用户的缓存一起失效（后端接口设计 §7.2.6）。 */
  async invalidateRole(roleId: string): Promise<void> {
    const id = toId(roleId);
    if (id === null) {
      return;
    }
    const links = await this.db.sysUserRole.findMany({
      where: { roleId: id },
      select: { userId: true },
    });
    this.cache.deleteMany(links.map((link) => link.userId.toString()));
  }

  /** 兜底：批量数据修复或导入后整体清空。 */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** 仅供测试断言缓存命中情况。 */
  get cachedUserCount(): number {
    return this.cache.size;
  }

  private async loadFromDb(userId: string): Promise<ReadonlySet<string>> {
    const id = toId(userId);
    if (id === null) {
      return new Set<string>();
    }
    const links = await this.db.sysRolePermission.findMany({
      where: {
        role: { deletedAt: null, status: 1, userRoles: { some: { userId: id } } },
      },
      select: { permission: { select: { code: true } } },
    });
    return new Set<string>(links.map((link) => link.permission.code));
  }
}

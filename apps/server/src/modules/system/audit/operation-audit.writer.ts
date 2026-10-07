import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import { PRISMA_CLIENT } from '../persistence/prisma-token';
import type { Actor, RequestMeta } from '../common/actor';
import { redactAuditValue, toInputJson, type AuditValue } from '../common/audit-diff';

/**
 * `sys_oper_log` 的写入端（数据库设计 §4.1.9）。
 *
 * 读端在 log/operation-log.service.ts；写单独放一个类是因为它的约束和读完全不同：
 * **写失败不能把业务请求带崩**（业务已经提交成功），但必须在日志里留痕。
 * 另外 detail 落库前强制过一遍 redactAuditValue——脱敏是 §3.7 的红线，不能指望每个调用方自觉。
 */

/** 与 sys_oper_log.module 的取值约定对齐：`system:user` / `system:role` / `system:menu` / `proto:project` / `proto:prototype` / `proto:release`。 */
export type AuditModule =
  | 'proto:project'
  | 'proto:prototype'
  | 'proto:release'
  | 'system:menu'
  | 'system:role'
  | 'system:user';

/** sys_oper_log.action 的取值（§4.1.9 注释：create|update|delete|publish|rollback|policy…）。 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'reset_password',
  'change_password',
  'assign_role',
  'assign_permission',
  'enable',
  'disable',
  'archive',
  'unarchive',
  'policy',
  'set_member',
  'publish',
  'rollback',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditInput {
  readonly actor: Actor;
  readonly request: RequestMeta;
  readonly module: AuditModule;
  readonly action: AuditAction;
  /** §4.1.9 注释里的 resource_type 取值：project|release|user|role|menu（prototype 同 project 一档） */
  readonly resourceType: 'menu' | 'project' | 'prototype' | 'release' | 'role' | 'user';
  readonly resourceId: string;
  readonly resourceName?: string | null;
  /** before/after 差异或集合增删；落库前还会再脱敏一次 */
  readonly detail?: AuditValue | null;
  readonly success?: boolean;
  readonly errorMessage?: string | null;
  readonly durationMs?: number | null;
}

@Injectable()
export class OperationAuditWriter {
  private readonly logger = new Logger(OperationAuditWriter.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /**
   * best-effort 写审计。业务已经提交，这里抛错只会把一个成功操作变成 500，
   * 反而丢掉真实结果（并且用户会重复点击造成重复变更）。
   */
  async record(input: AuditInput): Promise<void> {
    try {
      await this.db.sysOperLog.create({
        data: {
          userId: toBigIntOrNull(input.actor.userId),
          username: input.actor.username,
          module: input.module,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          resourceName: input.resourceName ?? null,
          method: input.request.method,
          path: truncate(input.request.path, 300),
          detail: this.toDetail(input.detail),
          ip: input.request.ip,
          success: input.success ?? true,
          errorMessage: truncate(input.errorMessage ?? null, 500),
          durationMs: input.durationMs ?? null,
        },
      });
    } catch (error: unknown) {
      this.logger.error(
        {
          auditModule: input.module,
          action: input.action,
          resourceId: input.resourceId,
          error: error instanceof Error ? error.message : String(error),
        },
        '操作日志写入失败（业务操作本身已成功），请检查 sys_oper_log 可用性',
      );
    }
  }

  /** detail 恒不为"密码明文"：任何键名命中敏感特征的 value 在进入 jsonb 之前就被替换。 */
  private toDetail(
    detail: AuditValue | null | undefined,
  ): Prisma.InputJsonValue | undefined {
    // 返回 undefined 而不是 null：Prisma 的 Json? 字段要求"显式清空"用 DbNull/JsonNull 枚举，
    // 而 create 里省略该键本来就是 NULL，省掉一次枚举依赖。
    if (detail === null || detail === undefined) {
      return undefined;
    }
    return toInputJson(redactAuditValue(detail));
  }
}

/** 登录态里的 id 是字符串（后端接口设计 §1.1：bigint 序列化成 string）；非数字就当没有操作者，不炸整条审计。 */
function toBigIntOrNull(value: string): bigint | null {
  return /^\d{1,19}$/.test(value) ? BigInt(value) : null;
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

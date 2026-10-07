import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@protohub/db';

import { PRISMA_CLIENT } from '../../common/permission/prisma-client';

export interface LoginLogRecord {
  readonly userId?: string | null;
  readonly username: string;
  readonly loginType: 'login' | 'logout' | 'refresh_fail';
  readonly success: boolean;
  readonly failReason?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

const MAX_USERNAME = 50;
const MAX_FAIL_REASON = 120;
const MAX_USER_AGENT = 500;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

function toBigInt(value: string | null | undefined): bigint | null {
  if (value && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/**
 * 登录日志落库（sys_login_log）。
 *
 * 审计写失败**不能**把登录接口带崩：这里一律吞掉异常只出 warn。
 * 用户名要裁剪：登录失败的输入长度不可控，而列是 varchar(50)，超长会让整条插入报错。
 */
@Injectable()
export class LoginLogService {
  private readonly logger = new Logger(LoginLogService.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  async record(entry: LoginLogRecord): Promise<void> {
    try {
      await this.db.sysLoginLog.create({
        data: {
          userId: toBigInt(entry.userId),
          username: clip(entry.username, MAX_USERNAME) ?? 'unknown',
          loginType: entry.loginType,
          success: entry.success,
          failReason: clip(entry.failReason, MAX_FAIL_REASON),
          ip: clip(entry.ip, 64),
          userAgent: clip(entry.userAgent, MAX_USER_AGENT),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        '登录日志写入失败（不影响登录结果）',
      );
    }
  }
}

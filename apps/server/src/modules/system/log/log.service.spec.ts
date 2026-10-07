import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { normalizePageQuery } from '../../../common/pagination/pagination';
import { LogService, toDetailRecord, toLoginLogItem, toOperLogItem, type LoginLogRow, type OperLogRow } from './log.service';
import { loginLogQuerySchema, operLogQuerySchema } from './log.dto';

/**
 * LogService 单测（后端接口设计 §7.5）：筛选条件必须原样进 where（success=false 不能被真值判断吞掉），
 * bigint/id 序列化成 string，detail 只透出 JSON 对象（写端已脱敏，读端不再加工）。
 */

function loginRow(overrides: Partial<LoginLogRow> = {}): LoginLogRow {
  return {
    id: 100n,
    userId: 5n,
    username: 'admin',
    loginType: 'login',
    success: true,
    failReason: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    createdAt: new Date('2026-01-02T03:04:05Z'),
    ...overrides,
  };
}

function operRow(overrides: Partial<OperLogRow> = {}): OperLogRow {
  return {
    id: 200n,
    userId: 5n,
    username: 'admin',
    module: 'system:role',
    action: 'assign_permission',
    resourceType: 'role',
    resourceId: '7',
    resourceName: '质量负责人',
    method: 'PUT',
    path: '/api/system/roles/7/permissions',
    detail: { permissions: { added: ['system:role:list'], removed: [] } },
    ip: '127.0.0.1',
    success: true,
    errorMessage: null,
    durationMs: 12,
    createdAt: new Date('2026-01-02T03:04:06Z'),
    ...overrides,
  };
}

function createFakeDb() {
  const fake = {
    sysLoginLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    sysOperLog: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { ...fake, db: fake as unknown as PrismaClient };
}

describe('LogService.loginLogs（§7.5.1）', () => {
  it('username/success/时间范围逐条进 where；success=false 是被识别的筛选而不是"未填"', async () => {
    const fake = createFakeDb();
    const service = new LogService(fake.db);
    const query = {
      username: 'adm',
      success: 'false',
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-01-31T23:59:59Z',
    };
    const filter = loginLogQuerySchema.parse(query);

    fake.sysLoginLog.findMany.mockResolvedValue([loginRow()]);
    fake.sysLoginLog.count.mockResolvedValue(1);

    const page = normalizePageQuery({ page: 2, pageSize: 10 });
    const data = await service.loginLogs(filter, page);

    const expectedWhere = {
      createdAt: {
        gte: new Date('2026-01-01T00:00:00Z'),
        lte: new Date('2026-01-31T23:59:59Z'),
      },
      success: false,
      username: { contains: 'adm', mode: 'insensitive' },
    };
    expect(fake.sysLoginLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere, skip: 10, take: 10, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
    expect(fake.sysLoginLog.count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({ id: '100', userId: '5', createdAt: '2026-01-02T03:04:05.000Z' });
  });

  it('空 query：不加任何筛选项；匿名失败记录 userId 为 null', async () => {
    const fake = createFakeDb();
    const service = new LogService(fake.db);
    const filter = loginLogQuerySchema.parse({});
    fake.sysLoginLog.findMany.mockResolvedValue([loginRow({ userId: null, success: false, loginType: 'refresh_fail' })]);

    const data = await service.loginLogs(filter, normalizePageQuery({}));
    const where = fake.sysLoginLog.findMany.mock.calls[0]?.[0]?.where;
    expect(where.username).toBeUndefined();
    expect(where.success).toBeUndefined();
    expect(data.items[0]).toMatchObject({ userId: null, success: false, loginType: 'refresh_fail' });
  });
});

describe('LogService.operLogs（§7.5.2）', () => {
  it('resourceType/resourceId/action/username 筛选 + 倒序分页', async () => {
    const fake = createFakeDb();
    const service = new LogService(fake.db);
    const filter = operLogQuerySchema.parse({
      resourceType: 'role',
      resourceId: '7',
      action: 'assign_permission',
      username: 'admin',
    });
    fake.sysOperLog.findMany.mockResolvedValue([operRow()]);
    fake.sysOperLog.count.mockResolvedValue(1);

    const data = await service.operLogs(filter, normalizePageQuery({ page: 1, pageSize: 20 }));
    expect(fake.sysOperLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          resourceType: 'role',
          resourceId: '7',
          action: 'assign_permission',
          username: { contains: 'admin', mode: 'insensitive' },
        }),
        skip: 0,
        take: 20,
      }),
    );
    expect(data.items[0]?.detail).toEqual({
      permissions: { added: ['system:role:list'], removed: [] },
    });
  });

  it('resourceId 不是数字 id 串 → 400（PARAM_INVALID 由 zod 管道层给到人话）', () => {
    const result = operLogQuerySchema.safeParse({ resourceId: 'role-7' });
    expect(result.success).toBe(false);
  });

  it('映射：datetime 转 ISO、detail 数组/标量脏数据降级为 null', () => {
    expect(toDetailRecord(['a'])).toBeNull();
    expect(toDetailRecord('oops')).toBeNull();
    expect(toDetailRecord(null)).toBeNull();
    expect(toDetailRecord({ ok: 1 })).toEqual({ ok: 1 });

    const item = toOperLogItem(operRow({ detail: [1, 2] }));
    expect(item.detail).toBeNull();
    expect(item.createdAt).toBe('2026-01-02T03:04:06.000Z');
    expect(toLoginLogItem(loginRow({ userId: null })).userId).toBeNull();
  });
});

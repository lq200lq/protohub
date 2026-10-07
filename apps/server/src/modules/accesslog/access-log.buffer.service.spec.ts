import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCESS_LOG_FLUSH_INTERVAL_MS,
  ACCESS_LOG_FLUSH_MAX_ROWS,
  ACCESS_LOG_MAX_BUFFERED_ROWS,
} from '../../config/constants';
import type { AccessLogRow } from './access-log.repo';
import { AccessLogBufferService } from './access-log.buffer.service';

/**
 * 缓冲层（机制 §6「异步批量写入：上限 500 条或 2 秒」；迭代实施计划 M4-T9）。
 *
 * 只桩 `AccessLogRepo.insertMany`；定时器用 fake timers 推进——"2 秒"这条承诺既没法
 * 用真时间等，也不该等（CI 上会变成随机变慢的测试）。
 */
function row(index: number): AccessLogRow {
  return {
    browser: 'Chrome 141',
    createdAt: new Date(Date.UTC(2026, 9, (index % 28) + 1, 8)),
    device: 'desktop',
    ip: '10.0.0.1',
    isBot: false,
    os: 'macOS',
    path: `/p/crm/crm-p01/assets/f${String(index)}.js`,
    prototypeId: 31n,
    referer: null,
    releaseId: 77n,
    result: 'ok',
    routeKey: 'crm/crm-p01',
    ua: 'Chrome/141',
    userId: null,
  };
}

/** 自己可控的写库桩：`settle()` 之前挂住、之后（含之后新到的批次）立刻成功。 */
interface RepoDouble {
  batches: AccessLogRow[][];
  calls: number;
  insertMany: ReturnType<typeof vi.fn>;
  settle: () => void;
}

function repoDouble(outcome: 'fail' | 'ok' | 'pending' = 'ok'): RepoDouble {
  const batches: AccessLogRow[][] = [];
  const waiters: (() => void)[] = [];
  let released = outcome !== 'pending';
  const insertMany = vi.fn((rows: readonly AccessLogRow[]) => {
    batches.push([...rows]);
    if (outcome === 'fail') {
      return Promise.reject(new Error('P2002: unique constraint failed'));
    }
    if (released) {
      return Promise.resolve(rows.length);
    }
    return new Promise<number>((resolve) => {
      waiters.push(() => {
        resolve(rows.length);
      });
    });
  });
  return {
    batches,
    get calls(): number {
      return insertMany.mock.calls.length;
    },
    insertMany,
    settle: () => {
      released = true;
      for (const done of waiters.splice(0)) {
        done();
      }
    },
  };
}

function harness(repo: RepoDouble): {
  service: AccessLogBufferService;
  warns: ReturnType<typeof vi.spyOn>;
} {
  const service = new AccessLogBufferService(
    repo as unknown as ConstructorParameters<typeof AccessLogBufferService>[0],
  );
  // 缓冲满与写失败都只 warn：不桩掉 Logger 的话，预期内的告警会把测试输出刷满
  const warns = vi.spyOn(
    (
      service as unknown as {
        logger: { warn: (first: unknown, ...rest: unknown[]) => void };
      }
    ).logger,
    'warn',
  ).mockImplementation(() => undefined);
  return { service, warns };
}

/** 推进 fake timers 并把期间产生的微任务跑完。 */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 只把已排队的 `drain` 跑起来，不动那个 2 秒窗口（用来证明"是条数触发的，不是定时器"）。 */
function microtasks(): Promise<void> {
  return tick(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('写库时机由两个条件决定（机制 §6）', () => {
  it('不到 500 条就先攒着：第 2 秒整写一次', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    service.enqueue(row(1));
    service.enqueue(row(2));
    service.enqueue(row(3));
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS - 1);

    expect(repo.calls).toBe(0);

    await tick(1);

    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toHaveLength(3);
  });

  it('第 500 条立刻冲，不等窗口', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    for (let i = 0; i < ACCESS_LOG_FLUSH_MAX_ROWS; i += 1) {
      service.enqueue(row(i));
    }
    await microtasks();

    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toHaveLength(ACCESS_LOG_FLUSH_MAX_ROWS);
  });

  it('按条数冲完之后不留空转的定时器（否则下一条要等两个 2 秒）', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    service.enqueue(row(0));
    for (let i = 1; i < ACCESS_LOG_FLUSH_MAX_ROWS; i += 1) {
      service.enqueue(row(i));
    }
    await microtasks();
    repo.settle();
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS + 10);

    // 只有条数那一次写入：定时器在 flush 时被清掉，攒着的第 0 条也已经跟着写走了
    expect(repo.calls).toBe(1);
  });

  it('一个窗口内只排一个定时器：100 条请求不会排出 100 个 2 秒', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    for (let i = 0; i < 100; i += 1) {
      service.enqueue(row(i));
    }
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS);

    expect(repo.calls).toBe(1);
    expect(repo.batches[0]).toHaveLength(100);
  });
});

describe('批次串行，且一次不超过 500 条', () => {
  it('上一批还在写时不会并发发第二条 createMany', async () => {
    const repo = repoDouble('pending');
    const { service } = harness(repo);

    for (let i = 0; i < ACCESS_LOG_FLUSH_MAX_ROWS; i += 1) {
      service.enqueue(row(i));
    }
    await microtasks();
    expect(repo.calls).toBe(1);

    service.enqueue(row(999));
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS);
    // 第二次 flush 只排进链，没越过在写的那一批
    expect(repo.calls).toBe(1);

    repo.settle();
    await microtasks();
    expect(repo.calls).toBe(2);
    expect(repo.batches[1]).toHaveLength(1);
  });

  it('突发塞进 1200 条时拆成三批写，剩下的那些不会被忘在内存里', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    for (let i = 0; i < 1_200; i += 1) {
      service.enqueue(row(i));
    }
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS * 3);
    repo.settle();
    await microtasks();

    const written = repo.batches.reduce((sum, batch) => sum + batch.length, 0);
    expect(written).toBe(1_200);
    expect(repo.batches.every((batch) => batch.length <= ACCESS_LOG_FLUSH_MAX_ROWS)).toBe(true);
  });
});

describe('缓冲上限：宁可丢记录也不涨内存', () => {
  it('写库卡住时攒到上限就丢新到的，已攒下的照样写得出去', async () => {
    const repo = repoDouble('pending');
    const { service, warns } = harness(repo);

    for (let i = 0; i < ACCESS_LOG_MAX_BUFFERED_ROWS + 5; i += 1) {
      service.enqueue(row(i));
    }
    repo.settle();
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS * 2);

    const written = repo.batches.reduce((sum, batch) => sum + batch.length, 0);
    expect(written).toBe(ACCESS_LOG_MAX_BUFFERED_ROWS);
    // 每 100 条报一次：5 条被丢只响第一下
    expect(warns).toHaveBeenCalledTimes(2);
    expect(String(warns.mock.calls[0]?.[0])).toMatch(/缓冲已满/);
    // 丢掉的数目会跟着下一次成功写入报出来，不然运维只看得到"写了 500 条"
    expect(String(warns.mock.calls[1]?.[0])).toMatch(/此前丢弃 5 条/);
  });
});

describe('写失败只落在本地日志（机制 §6：统计不该影响文件返回）', () => {
  it('插失败的那一批直接丢弃，不重试', async () => {
    const repo = repoDouble('fail');
    const { service, warns } = harness(repo);

    service.enqueue(row(1));
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS);

    expect(repo.calls).toBe(1);
    expect(warns).toHaveBeenCalledTimes(1);
    expect(warns.mock.calls[0]?.[1]).toContain('写入失败');
  });

  it('一批失败之后，下一批照常写（失败不是熔断）', async () => {
    const repo = repoDouble('fail');
    const { service } = harness(repo);

    service.enqueue(row(1));
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS);

    service.enqueue(row(2));
    await tick(ACCESS_LOG_FLUSH_INTERVAL_MS);

    expect(repo.calls).toBe(2);
  });

  it('enqueue 永远不抛：写库桩直接 reject 也传不到调用方', async () => {
    const repo = repoDouble('fail');
    const { service } = harness(repo);

    expect(() => {
      for (let i = 0; i < ACCESS_LOG_FLUSH_MAX_ROWS; i += 1) {
        service.enqueue(row(i));
      }
    }).not.toThrow();
    await microtasks();
  });
});

describe('进程退出前把尾巴冲掉', () => {
  it('onModuleDestroy 等的是真的写完，不是等排进队列', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    service.enqueue(row(1));
    service.enqueue(row(2));
    await service.onModuleDestroy();

    expect(repo.batches).toHaveLength(1);
    expect(repo.batches[0]).toHaveLength(2);
  });

  it('销毁时缓冲是空的也不写一次空批次', async () => {
    const repo = repoDouble();
    const { service } = harness(repo);

    await service.onModuleDestroy();

    expect(repo.calls).toBe(0);
  });
});

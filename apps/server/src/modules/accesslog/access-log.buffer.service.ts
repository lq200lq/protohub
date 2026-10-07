import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import {
  ACCESS_LOG_FLUSH_INTERVAL_MS,
  ACCESS_LOG_FLUSH_MAX_ROWS,
  ACCESS_LOG_MAX_BUFFERED_ROWS,
} from '../../config/constants';
import { AccessLogRepo, type AccessLogRow } from './access-log.repo';

/**
 * 访问记录的进程内缓冲（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §6
 * 「异步批量写入：上限 500 条或 2 秒」；迭代实施计划 M4-T9）。
 *
 * 三条承诺决定了这个类的形状：
 * 1. **绝不影响文件返回**——`enqueue()` 是同步的、不 await、不抛。静态访问的可用性优先于统计完整性（§6）,
 *    这条也是计划 §8 的 F-17（同步写库会让静态访问变慢、库故障还会 500）。
 * 2. **写失败只落本地日志**——插失败的那一批**直接丢弃，不重试**：数据库连着故障时重试只会把缓冲堆到
 *    内存上限，而 §6 从没承诺过"记录一定在"。
 * 3. **进程退出前把尾巴冲掉**——`onModuleDestroy` 里 flush；否则每次重启都会丢掉最后不到 2 秒的记录，
 *    而重启正好是排障时最常看的时刻。
 *
 * 批次串行（`tail` 链）而不是并发发多条 `createMany`：同一张表上并发批量插入只会让锁等待互相拖慢，
 * 而且串行让"上一次失败还在写、这一次又开始"变成不可能。
 */
@Injectable()
export class AccessLogBufferService implements OnModuleDestroy {
  private readonly logger = new Logger(AccessLogBufferService.name);
  private readonly pending: AccessLogRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tail: Promise<void> = Promise.resolve();
  /** 因为缓冲满而被丢掉的数量；下一次成功写入时一起报出来。 */
  private dropped = 0;

  constructor(private readonly repo: AccessLogRepo) {}

  enqueue(row: AccessLogRow): void {
    if (this.pending.length >= ACCESS_LOG_MAX_BUFFERED_ROWS) {
      this.dropped += 1;
      // 每 100 条报一次：缓冲会满通常意味着库在故障或有人在刷，逐条 warn 只会加重那两件事。
      if (this.dropped % 100 === 1) {
        this.logger.warn(
          `访问记录缓冲已满（上限 ${String(ACCESS_LOG_MAX_BUFFERED_ROWS)} 条），已累计丢弃 ${String(this.dropped)} 条`,
        );
      }
      return;
    }
    this.pending.push(row);
    if (this.pending.length >= ACCESS_LOG_FLUSH_MAX_ROWS) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /**
   * 立即把缓冲写掉（条数触发与测试都用这里）。返回的 Promise 在**这一批**写完后 resolve，
   * 但调用方（`enqueue`）从不 await 它——只有生命周期钩子和单测关心写入结果。
   */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tail = this.tail.then(() => this.drain());
    return this.tail;
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  /** 定时器不挂住进程退出（开发时 Ctrl-C、测试结束时都不该为一条统计多等 2 秒）。 */
  private schedule(): void {
    if (this.timer !== null) {
      return;
    }
    const timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ACCESS_LOG_FLUSH_INTERVAL_MS);
    timer.unref();
    this.timer = timer;
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    // 一次只取一批（500）：突发到达（比如有人拿脚本刷链接）可能在一轮事件循环里塞进远超 500 条，
    // 整包 `createMany` 会让单条 SQL 的参数个数冲到几万，反而变成写库侧的故障源。
    const batch = this.pending.splice(0, ACCESS_LOG_FLUSH_MAX_ROWS);
    const dropped = this.dropped;
    this.dropped = 0;
    // 取完还剩下的行要重新排窗口：触发这批写入的那次 `enqueue` 已经把定时器清掉了，
    // 不重排的话剩下的行会一直躺到下一条记录进来（或进程退出）才写得出去。
    if (this.pending.length > 0) {
      this.schedule();
    }
    try {
      const count = await this.repo.insertMany(batch);
      if (count !== batch.length || dropped > 0) {
        this.logger.warn(
          `访问记录写入 ${String(count)}/${String(batch.length)} 条${dropped > 0 ? `，此前丢弃 ${String(dropped)} 条` : ''}`,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          rows: batch.length,
          dropped,
        },
        '访问记录写入失败，这批已丢弃（不影响静态访问）',
      );
    }
  }
}

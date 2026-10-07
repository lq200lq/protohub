import { describe, expect, it } from 'vitest';

import { runInTraceContext } from '../context/trace-context';
import { isSensitiveKey, redactValue } from './logger-redact';
import {
  buildLogEntry,
  createPinoLogger,
  PinoLoggerService,
  type PinoWriter,
} from './pino-logger.service';

interface RecordedCall {
  readonly level: keyof PinoWriter;
  readonly payload: Record<string, unknown>;
  readonly msg: string;
}

class RecordingWriter implements PinoWriter {
  readonly calls: RecordedCall[] = [];

  fatal(payload: Record<string, unknown>, msg: string): void {
    this.record('fatal', payload, msg);
  }
  error(payload: Record<string, unknown>, msg: string): void {
    this.record('error', payload, msg);
  }
  warn(payload: Record<string, unknown>, msg: string): void {
    this.record('warn', payload, msg);
  }
  info(payload: Record<string, unknown>, msg: string): void {
    this.record('info', payload, msg);
  }
  debug(payload: Record<string, unknown>, msg: string): void {
    this.record('debug', payload, msg);
  }
  trace(payload: Record<string, unknown>, msg: string): void {
    this.record('trace', payload, msg);
  }

  private record(
    level: keyof PinoWriter,
    payload: Record<string, unknown>,
    msg: string,
  ): void {
    this.calls.push({ level, payload, msg });
  }

  get last(): RecordedCall {
    const entry = this.calls.at(-1);
    if (!entry) {
      throw new Error('没有记录到任何日志调用');
    }
    return entry;
  }
}

describe('日志脱敏（字段名命中 *secret* / password / token / authorization）', () => {
  it('敏感字段名判定覆盖大小写与子串', () => {
    for (const key of [
      'JWT_ACCESS_SECRET',
      'accessTokenSecret',
      'password',
      'refreshToken',
      'authorization',
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['username', 'traceId', 'hostname', 'projectId']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('嵌套对象与数组里的敏感字段也一起脱敏', () => {
    const redacted = redactValue({
      user: 'admin',
      password: 'p@ssw0rd',
      nested: { sessionCookieSecret: 'abc', keep: 1 },
      list: [{ token: 'jwt...' }, { note: 'ok' }],
    }) as Record<string, unknown>;

    expect(redacted['user']).toBe('admin');
    expect(redacted['password']).toBe('[REDACTED]');
    expect((redacted['nested'] as Record<string, unknown>)['sessionCookieSecret']).toBe(
      '[REDACTED]',
    );
    expect((redacted['list'] as Array<Record<string, unknown>>)[0]?.['token']).toBe(
      '[REDACTED]',
    );
    expect(JSON.stringify(redacted)).not.toContain('p@ssw0rd');
  });

  it('自引用结构不会把日志线程打死', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    expect(redactValue(cyclic)).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });
});

describe('PinoLoggerService 对接 Nest LoggerService', () => {
  it('Nest 的 log 映射到 pino 的 info，末尾字符串按 context 处理', () => {
    const writer = new RecordingWriter();
    const service = new PinoLoggerService(writer);

    service.log('发布完成', 'ReleaseService');

    expect(writer.last.level).toBe('info');
    expect(writer.last.msg).toBe('发布完成');
    expect(writer.last.payload['context']).toBe('ReleaseService');
  });

  it('对象形式的日志一并脱敏，敏感值不会落到 stdout', () => {
    const writer = new RecordingWriter();
    const service = new PinoLoggerService(writer);

    service.log({
      username: 'admin',
      password: 'p@ssw0rd',
      loginIp: '127.0.0.1',
    });

    expect(writer.last.payload).toEqual({
      username: 'admin',
      password: '[REDACTED]',
      loginIp: '127.0.0.1',
    });
  });

  it('一次请求内的日志自动带上 traceId（M0-T6：能按 traceId 串起来）', () => {
    const writer = new RecordingWriter();
    const service = new PinoLoggerService(writer);

    runInTraceContext('trace-abc', () => {
      service.log('第一条');
      service.warn({ step: 'second' });
    });

    expect(writer.calls[0]?.payload['traceId']).toBe('trace-abc');
    expect(writer.calls[1]?.payload['traceId']).toBe('trace-abc');
  });

  it('错误对象只保留 name/message（堆栈由过滤器单独放 bindings）', () => {
    const entry = buildLogEntry(new Error('连不上 protohub 库'));

    expect(entry.bindings).toEqual({
      name: 'Error',
      message: '连不上 protohub 库',
    });
  });

  it('createPinoLogger 按配置的级别建实例，且结构上满足 PinoWriter', () => {
    const logger = createPinoLogger('warn');

    expect(logger.level).toBe('warn');
    // 只是类型层面的断言：能赋值给 PinoWriter 就说明服务能换用真实 pino 实例
    const writer: PinoWriter = logger;
    expect(typeof writer.info).toBe('function');
  });
});

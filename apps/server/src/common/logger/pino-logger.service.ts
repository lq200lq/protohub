import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { pino, type Logger as PinoLogger } from 'pino';

import { currentTraceId } from '../context/trace-context';
import { redactValue } from './logger-redact';

/** 只用到的 pino 方法子集：便于单测注入替身，也不必把 pino 类型散到业务里。 */
export interface PinoWriter {
  fatal(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
  info(payload: Record<string, unknown>, msg: string): void;
  debug(payload: Record<string, unknown>, msg: string): void;
  trace(payload: Record<string, unknown>, msg: string): void;
}

export const PINO_INSTANCE = 'PROTOHUB_PINO_INSTANCE';

export type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export function createPinoLogger(level: PinoLevel): PinoLogger {
  return pino({ level });
}

export interface LogEntry {
  readonly bindings: Record<string, unknown>;
  readonly msg: string;
}

/**
 * 把 Nest 的 `(message, ...optionalParams)` 约定折成 pino 的 `(bindings, msg)`：
 * 末尾的字符串按 Nest 语义当作 context，对象并入 bindings，全程脱敏。
 */
export function buildLogEntry(
  message: unknown,
  optionalParams: readonly unknown[] = [],
): LogEntry {
  const bindings: Record<string, unknown> = {};
  const traceId = currentTraceId();
  if (traceId) {
    bindings['traceId'] = traceId;
  }
  const texts: string[] = [];

  const params = [...optionalParams];
  const trailing = params.at(-1);
  if (typeof trailing === 'string') {
    params.pop();
    bindings['context'] = trailing;
  }

  const collect = (value: unknown): void => {
    if (value === undefined || value === null) {
      return;
    }
    const type = typeof value;
    if (
      type === 'string' ||
      type === 'number' ||
      type === 'boolean' ||
      type === 'bigint'
    ) {
      texts.push(String(value));
      return;
    }
    const redacted = redactValue(value);
    if (redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)) {
      Object.assign(bindings, redacted as Record<string, unknown>);
      return;
    }
    bindings['data'] = redacted;
  };

  collect(message);
  for (const param of params) {
    collect(param);
  }

  const context = bindings['context'];
  const msg =
    texts.join(' ').trim() ||
    (typeof context === 'string' && context !== '' ? context : 'log');
  return { bindings, msg };
}

/** pino 对接 Nest LoggerService；Nest 的 `log` 对应 pino 的 `info`，`verbose` 对应 `trace`。 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(@Inject(PINO_INSTANCE) private readonly writer: PinoWriter) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  trace(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  private write(
    level: keyof PinoWriter,
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    const entry = buildLogEntry(message, optionalParams);
    this.writer[level](entry.bindings, entry.msg);
  }
}

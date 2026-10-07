import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface TraceContext {
  readonly traceId: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** 允许透传的 traceId 形态：纯可见字符、长度受限，防止日志注入与超长值污染检索。 */
const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function createTraceId(): string {
  return randomUUID();
}

export function sanitizeTraceId(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return TRACE_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 有合法的外部 traceId 就沿用（跨服务串链），否则新生成。 */
export function resolveTraceId(incoming: string | undefined): string {
  return sanitizeTraceId(incoming) ?? createTraceId();
}

export function runInTraceContext<T>(traceId: string, action: () => T): T {
  return storage.run({ traceId }, action);
}

/** 当前请求的 traceId；不在请求上下文里（启动阶段、定时任务）返回 undefined。 */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

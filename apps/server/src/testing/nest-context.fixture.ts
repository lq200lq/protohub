import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';

import type { HttpReplyLike, TraceableRequest } from '../common/http-types';

export interface ReplyCapture {
  readonly statusCodes: number[];
  readonly bodies: unknown[];
  readonly headers: Record<string, string>;
  readonly reply: HttpReplyLike;
}

/** 记录 status/send/header 调用的假响应对象（结构上满足 HttpReplyLike）。 */
export function createReplyCapture(): ReplyCapture {
  const statusCodes: number[] = [];
  const bodies: unknown[] = [];
  const headers: Record<string, string> = {};
  const reply: HttpReplyLike = {
    status(code: number): unknown {
      statusCodes.push(code);
      return reply;
    },
    send(body: unknown): unknown {
      bodies.push(body);
      return reply;
    },
    header(name: string, value: string): unknown {
      headers[name] = value;
      return reply;
    },
  };
  return { statusCodes, bodies, headers, reply };
}

export function createRequest(
  headers: Record<string, unknown> = {},
  overrides: Partial<TraceableRequest> = {},
): TraceableRequest {
  return { headers, method: 'GET', url: '/api/health', ...overrides };
}

export interface HttpContextFixture {
  readonly context: ExecutionContext;
  readonly argumentsHost: ArgumentsHost;
  readonly request: TraceableRequest;
  readonly reply: HttpReplyLike;
  readonly capture: ReplyCapture;
  readonly handler: () => unknown;
}

/**
 * 只造单测需要的最小 Nest 上下文：拦截器/过滤器用到的那几个方法。
 * 用 `as unknown as` 收敛到公开接口，避免为凑接口去实现 rpc/ws 分支。
 */
export function createHttpContextFixture(input: {
  request?: TraceableRequest;
  reply?: HttpReplyLike;
  handler?: () => unknown;
} = {}): HttpContextFixture {
  const capture = createReplyCapture();
  const request = input.request ?? createRequest();
  const reply = input.reply ?? capture.reply;
  const handler = input.handler ?? (() => undefined);

  const http = {
    getRequest<T>(): T {
      return request as unknown as T;
    },
    getResponse<T>(): T {
      return reply as unknown as T;
    },
    getNext<T>(): T {
      return undefined as unknown as T;
    },
  };

  const partial = {
    switchToHttp: () => http,
    getHandler: () => handler,
    getClass: () => class {},
    getArgByIndex: (index: number) => (index === 0 ? request : reply),
    getType: () => 'http' as const,
  };

  return {
    context: partial as unknown as ExecutionContext,
    argumentsHost: partial as unknown as ArgumentsHost,
    request,
    reply,
    capture,
    handler,
  };
}

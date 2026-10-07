import { Injectable, type NestMiddleware } from '@nestjs/common';

import { TRACE_ID_HEADER } from '../../config/constants';
import {
  resolveTraceId,
  runInTraceContext,
} from '../context/trace-context';
import {
  readRequestHeader,
  setResponseHeader,
  type ResponseHeaderWriter,
  type TraceableRequest,
} from '../http-types';

/**
 * X-Trace-Id：沿用合法的入站值，否则新生成；写响应头 + 挂到请求对象 + 建立 ALS 日志上下文。
 * 见 后端接口设计.md §1.5（报障时让用户提供这个值）。
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(
    request: TraceableRequest,
    reply: ResponseHeaderWriter,
    next: (error?: unknown) => void,
  ): void {
    const traceId = resolveTraceId(
      readRequestHeader(request, TRACE_ID_HEADER),
    );
    // 挂到请求上：异常过滤器在拦截器/ALS 之外执行，只能从 request 拿 traceId。
    request.traceId = traceId;
    setResponseHeader(reply, TRACE_ID_HEADER, traceId);
    runInTraceContext(traceId, () => next());
  }
}

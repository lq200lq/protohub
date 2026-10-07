import {
  ArgumentsHost,
  Catch,
  HttpException,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';

import { TRACE_ID_HEADER } from '../../config/constants';
import { currentTraceId, runInTraceContext } from '../context/trace-context';
import {
  setResponseHeader,
  type HttpReplyLike,
  type TraceableRequest,
} from '../http-types';
import {
  HTTP_ERROR_CODE_PREFIX,
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  toErrorEnvelope,
} from '../response/api-envelope';
import { BusinessException } from './business.exception';

interface FailureDescription {
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly message: string;
}

function frameworkExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const record = response as Record<string, unknown>;
  const message = record['message'];
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    return message.filter((item): item is string => typeof item === 'string').join('；');
  }
  return exception.message;
}

/**
 * 把所有异常收敛成非 2xx + `{ code: -1, error, errorCode, message }`。
 * 见 后端接口设计.md §1.2 / §1.4：未知异常只给 500 与 traceId，不外泄堆栈。
 */
@Catch()
export class BusinessExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(BusinessExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<TraceableRequest>();
    const reply = http.getResponse<HttpReplyLike>();
    const traceId = request?.traceId ?? currentTraceId() ?? 'no-trace';
    const failure = this.describe(exception);

    // 日志与响应都放在 trace 上下文里：过滤器在拦截器/中间件作用域之外，需要显式重建。
    runInTraceContext(traceId, () => {
      this.logFailure(failure, exception, request);
      const envelope = toErrorEnvelope({
        message: failure.message,
        errorCode: failure.errorCode,
      });
      setResponseHeader(reply, TRACE_ID_HEADER, traceId);
      reply.status(failure.httpStatus);
      reply.send(envelope);
    });
  }

  private describe(exception: unknown): FailureDescription {
    if (exception instanceof BusinessException) {
      return {
        httpStatus: exception.httpStatus,
        errorCode: exception.errorCode,
        message: exception.message,
      };
    }
    // 框架自带异常（守卫、管道等）保留其状态码，错误码给可推导的兜底值。
    if (exception instanceof HttpException) {
      return {
        httpStatus: exception.getStatus(),
        errorCode: `${HTTP_ERROR_CODE_PREFIX}${exception.getStatus()}`,
        message: frameworkExceptionMessage(exception),
      };
    }
    return {
      httpStatus: 500,
      errorCode: INTERNAL_ERROR_CODE,
      message: INTERNAL_ERROR_MESSAGE,
    };
  }

  private logFailure(
    failure: FailureDescription,
    exception: unknown,
    request: TraceableRequest,
  ): void {
    const bindings = {
      method: request?.method,
      url: request?.url,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
    };
    if (failure.httpStatus === 500 && exception instanceof Error) {
      // 堆栈只进日志，响应里只有 traceId 可查。
      this.logger.error(
        { ...bindings, stack: exception.stack, name: exception.name },
        BusinessExceptionFilter.name,
      );
      return;
    }
    this.logger.warn(bindings, BusinessExceptionFilter.name);
  }
}

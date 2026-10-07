import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, map, throwError, type Observable } from 'rxjs';

import type { HttpRequestLike } from '../http-types';
import { BusinessException } from '../exception/business.exception';

/**
 * 请求日志：方法 + 路径 + 耗时，traceId 由 PinoLoggerService 从 ALS 取，
 * 因此一次请求的多条日志能按 traceId 串起来（迭代实施计划 M0-T6 的完成判据）。
 */
@Injectable()
export class AccessLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('access');

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const startedAt = process.hrtime.bigint();
    const request = context.switchToHttp().getRequest<HttpRequestLike>();

    const summary = (): Record<string, unknown> => ({
      method: request?.method,
      url: request?.url,
      durationMs: Number(
        (process.hrtime.bigint() - startedAt) / 1_000_000n,
      ),
    });

    return next.handle().pipe(
      map((data: unknown) => {
        this.logger.log(summary());
        return data;
      }),
      catchError((error: unknown) => {
        const httpStatus =
          error instanceof BusinessException ? error.httpStatus : undefined;
        this.logger.warn({ ...summary(), httpStatus });
        return throwError(() => error);
      }),
    );
  }
}

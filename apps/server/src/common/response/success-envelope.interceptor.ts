import 'reflect-metadata';

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { toSuccessEnvelope } from './api-envelope';
import { SKIP_ENVELOPE_KEY } from './skip-envelope.decorator';

/**
 * 成功响应统一包装成 `{ code: 0, data, error: null, message }`。
 * 异常路径由 BusinessExceptionFilter 直接写响应，不经过这里。
 */
@Injectable()
export class SuccessEnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = context.getHandler();
    if (Reflect.getMetadata(SKIP_ENVELOPE_KEY, handler) === true) {
      return next.handle();
    }
    return next.handle().pipe(map((value: unknown) => toSuccessEnvelope(value)));
  }
}

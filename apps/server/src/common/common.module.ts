import {
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { AppEnvService } from '../config/app-env.service';
import { AppConfigModule } from '../config/config.module';
import { BusinessExceptionFilter } from './exception/business-exception.filter';
import { AccessLogInterceptor } from './logging/access-log.interceptor';
import {
  createPinoLogger,
  PinoLoggerService,
  PINO_INSTANCE,
  type PinoWriter,
} from './logger/pino-logger.service';
import { SuccessEnvelopeInterceptor } from './response/success-envelope.interceptor';
import { TraceIdMiddleware } from './trace/trace-id.middleware';

/**
 * 全局横切能力：traceId 中间件 → 访问日志 → 统一信封 → 异常过滤器。
 * 见 平台设计方案.md §7.1 的 `common`（统一响应拦截器、异常过滤器、分页）。
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PINO_INSTANCE,
      inject: [AppEnvService],
      useFactory: (env: AppEnvService): PinoWriter =>
        createPinoLogger(env.env.logLevel),
    },
    PinoLoggerService,
    TraceIdMiddleware,
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SuccessEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: BusinessExceptionFilter },
  ],
  exports: [PinoLoggerService],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // `{*path}` 是 path-to-regexp v8（Nest 11 + Fastify）的通配写法：所有路由都先拿到 traceId。
    consumer.apply(TraceIdMiddleware).forRoutes('{*path}');
  }
}

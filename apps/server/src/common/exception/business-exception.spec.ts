import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { createHttpContextFixture, createReplyCapture, createRequest } from '../../testing/nest-context.fixture';
import { BusinessExceptionFilter } from './business-exception.filter';
import {
  BusinessException,
  ForbiddenBusinessException,
  UnauthorizedException,
} from './business.exception';

describe('BusinessException：message 给人看，errorCode 给机器', () => {
  it('默认 400（参数/业务规则拒绝）', () => {
    const error = new BusinessException(
      '编码已被占用，请换一个',
      'PROTO_SLUG_DUPLICATED',
    );

    expect(error.message).toBe('编码已被占用，请换一个');
    expect(error.errorCode).toBe('PROTO_SLUG_DUPLICATED');
    expect(error.httpStatus).toBe(400);
  });

  it('401 只表示未登录/令牌失效（vben 只对 401 刷新令牌）', () => {
    const error = new UnauthorizedException();

    expect(error.httpStatus).toBe(401);
    expect(error.errorCode).toMatch(/^AUTH_/);
    expect(error).toBeInstanceOf(BusinessException);
  });

  it('403 只表示已登录但权限不足（不该被当成需要刷新）', () => {
    const error = new ForbiddenBusinessException();

    expect(error.httpStatus).toBe(403);
    expect(error.errorCode).toBe('AUTH_FORBIDDEN');
  });
});

describe('BusinessExceptionFilter：非 2xx + {code:-1,error,errorCode}', () => {
  const filter = new BusinessExceptionFilter();

  it('业务异常按自己的状态码返回，人话进 error、机器码进 errorCode', () => {
    const capture = createReplyCapture();
    const { argumentsHost } = createHttpContextFixture({
      request: createRequest({ host: '127.0.0.1' }),
      reply: capture.reply,
    });

    filter.catch(
      new BusinessException('编码已被占用，请换一个', 'PROTO_SLUG_DUPLICATED', 409),
      argumentsHost,
    );

    expect(capture.statusCodes).toEqual([409]);
    expect(capture.bodies[0]).toEqual({
      code: -1,
      data: null,
      error: '编码已被占用，请换一个',
      errorCode: 'PROTO_SLUG_DUPLICATED',
      message: '编码已被占用，请换一个',
    });
  });

  it('401 与 403 的状态码原样透出，不被统一压成 200 或 500', () => {
    const fortyOne = createReplyCapture();
    filter.catch(
      new UnauthorizedException(),
      createHttpContextFixture({ reply: fortyOne.reply }).argumentsHost,
    );
    const fortyThree = createReplyCapture();
    filter.catch(
      new ForbiddenBusinessException(),
      createHttpContextFixture({ reply: fortyThree.reply }).argumentsHost,
    );

    expect(fortyOne.statusCodes).toEqual([401]);
    expect(fortyThree.statusCodes).toEqual([403]);
    expect((fortyOne.bodies[0] as { code: number }).code).toBe(-1);
  });

  it('未预期异常回 500 + INTERNAL_ERROR，且不外泄内部消息与堆栈', () => {
    const capture = createReplyCapture();
    filter.catch(
      new Error('connection to postgres:5432 failed with SECRET_DSN'),
      createHttpContextFixture({ reply: capture.reply }).argumentsHost,
    );

    expect(capture.statusCodes).toEqual([500]);
    const body = capture.bodies[0] as Record<string, unknown>;
    expect(body['code']).toBe(-1);
    expect(body['errorCode']).toBe('INTERNAL_ERROR');
    expect(typeof body['error']).toBe('string');
    expect(String(body['error'])).not.toContain('postgres');
    expect(String(body['error'])).not.toContain('SECRET_DSN');
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('框架自带的 HttpException 保留状态码（守卫/管道抛的那些）', () => {
    const capture = createReplyCapture();
    filter.catch(
      new BadRequestException('username 必填'),
      createHttpContextFixture({ reply: capture.reply }).argumentsHost,
    );

    expect(capture.statusCodes).toEqual([400]);
    expect((capture.bodies[0] as { error: string }).error).toBe('username 必填');
  });

  it('响应头回传与日志一致的 X-Trace-Id', () => {
    const capture = createReplyCapture();
    const request = createRequest({ 'x-trace-id': 'trace-from-upstream' });
    request.traceId = 'trace-from-upstream';

    filter.catch(
      new ForbiddenBusinessException(),
      createHttpContextFixture({ request, reply: capture.reply }).argumentsHost,
    );

    expect(capture.headers['X-Trace-Id']).toBe('trace-from-upstream');
  });
});

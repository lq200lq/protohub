import { describe, expect, it } from 'vitest';

import { currentTraceId } from '../context/trace-context';
import {
  createReplyCapture,
  createRequest,
} from '../../testing/nest-context.fixture';
import { TraceIdMiddleware } from './trace-id.middleware';

const TRACE_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

function echoedTraceId(headers: Record<string, string>): string {
  const value = headers['X-Trace-Id'];
  expect(typeof value).toBe('string');
  return value ?? '';
}

describe('X-Trace-Id 中间件（后端接口设计 §1.5）', () => {
  const middleware = new TraceIdMiddleware();

  it('合法的入站 traceId 沿用，并回写响应头与请求对象', () => {
    const request = createRequest({ 'x-trace-id': 'upstream-id-001' });
    const capture = createReplyCapture();

    middleware.use(request, capture.reply, () => undefined);

    expect(echoedTraceId(capture.headers)).toBe('upstream-id-001');
    expect(request.traceId).toBe('upstream-id-001');
  });

  it('大小写不同的请求头也能读到', () => {
    const request = createRequest({ 'X-Trace-Id': 'MixedCase-02' });
    const capture = createReplyCapture();

    middleware.use(request, capture.reply, () => undefined);

    expect(request.traceId).toBe('MixedCase-02');
  });

  it('没有入站值时生成一个，且同一次请求内保持一致', () => {
    const request = createRequest();
    const capture = createReplyCapture();
    let insideFirst = '';
    let insideSecond = '';

    middleware.use(request, capture.reply, () => {
      insideFirst = currentTraceId() ?? '';
      insideSecond = currentTraceId() ?? '';
    });

    expect(insideFirst).not.toBe('');
    expect(TRACE_ID_SHAPE.test(insideFirst)).toBe(true);
    expect(insideSecond).toBe(insideFirst);
    expect(echoedTraceId(capture.headers)).toBe(insideFirst);
  });

  it('非法/超长的入站值被丢弃并重新生成（防日志注入）', () => {
    const rawInjected =
      'abc\nlevel=error msg=伪造日志 [SECURITY] ' + 'x'.repeat(200);
    const request = createRequest({ 'x-trace-id': rawInjected });
    const capture = createReplyCapture();

    middleware.use(request, capture.reply, () => undefined);

    const echoed = echoedTraceId(capture.headers);
    expect(TRACE_ID_SHAPE.test(echoed)).toBe(true);
    expect(echoed.includes('\n')).toBe(false);
    expect(echoed).not.toBe(rawInjected);
  });

  it('traceId 会带进日志上下文：中间件之后打的日志能按它串起来', () => {
    const request = createRequest({ 'x-trace-id': 'log-link-9' });
    const capture = createReplyCapture();
    let observed: string | undefined;

    middleware.use(request, capture.reply, () => {
      observed = currentTraceId();
    });

    expect(observed).toBe('log-link-9');
    // 出了请求作用域就该恢复，别把 traceId 漏给下一条请求
    expect(currentTraceId()).toBeUndefined();
  });
});

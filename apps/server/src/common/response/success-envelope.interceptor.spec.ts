import { Injectable, type CallHandler } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { firstValueFrom, of, type Observable } from 'rxjs';

import { createHttpContextFixture } from '../../testing/nest-context.fixture';
import {
  FAILURE_CODE,
  SUCCESS_CODE,
  SUCCESS_MESSAGE,
  toSuccessEnvelope,
} from './api-envelope';
import { SkipEnvelope } from './skip-envelope.decorator';
import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor';

function callHandler<TData>(value: TData): CallHandler<TData> {
  return { handle: (): Observable<TData> => of(value) };
}

describe('成功响应信封（后端接口设计 §1.2）', () => {
  const interceptor = new SuccessEnvelopeInterceptor();

  it('成功时是 {code:0,data,error:null,message}', async () => {
    const { context } = createHttpContextFixture();

    await expect(
      firstValueFrom(interceptor.intercept(context, callHandler({ id: '7' }))),
    ).resolves.toEqual({
      code: SUCCESS_CODE,
      data: { id: '7' },
      error: null,
      message: SUCCESS_MESSAGE,
    });
  });

  it('成功路径的 error 恒为 null，机器码绝不往那里放', async () => {
    const { context } = createHttpContextFixture();
    const envelope = await firstValueFrom(
      interceptor.intercept(context, callHandler('hello')),
    );

    expect(envelope).toEqual({
      code: 0,
      data: 'hello',
      error: null,
      message: SUCCESS_MESSAGE,
    });
    expect('errorCode' in (envelope as object)).toBe(false);
  });

  it('控制器返回 undefined 时 data 落成 null（§1.5：不返回 undefined）', async () => {
    const { context } = createHttpContextFixture();

    await expect(
      firstValueFrom(interceptor.intercept(context, callHandler(undefined))),
    ).resolves.toEqual({
      code: 0,
      data: null,
      error: null,
      message: SUCCESS_MESSAGE,
    });
  });

  it('@SkipEnvelope 的路由保持裸响应（/auth/refresh 是统一信封的唯一例外）', async () => {
    @Injectable()
    class AuthController {
      @SkipEnvelope()
      refresh(): string {
        return 'raw-token-string';
      }
    }

    const { context } = createHttpContextFixture({
      handler: AuthController.prototype.refresh,
    });

    await expect(
      firstValueFrom(
        interceptor.intercept(context, callHandler('raw-token-string')),
      ),
    ).resolves.toBe('raw-token-string');
  });

  it('假值不被 ?? 误伤：空串与 0 原样放进 data', () => {
    expect(toSuccessEnvelope('').data).toBe('');
    expect(toSuccessEnvelope(0).data).toBe(0);
    expect(toSuccessEnvelope(null).data).toBeNull();
  });

  it('失败信封的 code 是 -1（与成功码区分开）', () => {
    expect(FAILURE_CODE).toBe(-1);
    expect(SUCCESS_CODE).toBe(0);
  });
});

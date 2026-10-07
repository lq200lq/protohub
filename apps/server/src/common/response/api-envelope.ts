/**
 * 统一响应体，见 后端接口设计.md §1.2。
 *
 * 字段分工（迭代实施计划 §3.4 第一条，最容易写错的地方）：
 * - `error`   → 给人看的话；vben 的 errorMessageResponseInterceptor 取 `error ?? message`
 * - `errorCode` → 给机器/排障用的稳定码
 * 两者绝不能混用同一个字段承载。
 */

export const SUCCESS_CODE = 0;
export const FAILURE_CODE = -1;

/** §1.2 的成功样例里 message 是 "ok"。若后续要改成空串，只改这一处。 */
export const SUCCESS_MESSAGE = 'ok';

/** 500 的对外文案：不暴露堆栈，追踪靠 X-Trace-Id 头。 */
export const INTERNAL_ERROR_MESSAGE = '服务暂时不可用，请稍后重试';
export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';

/** 兜底：非业务异常（框架抛的 HttpException）没有约定错误码时用它。 */
export const HTTP_ERROR_CODE_PREFIX = 'HTTP_';

export interface ApiSuccessEnvelope<TData> {
  readonly code: typeof SUCCESS_CODE;
  readonly data: TData;
  readonly error: null;
  readonly message: string;
}

export interface ApiErrorEnvelope {
  readonly code: typeof FAILURE_CODE;
  readonly data: null;
  /** 给人看的文案 */
  readonly error: string;
  /** 给机器/排障用的稳定码 */
  readonly errorCode: string;
  /** 与 `error` 同值，兼容只读 message 的调用方 */
  readonly message: string;
}

export function toSuccessEnvelope<TData>(
  data: TData | null | undefined,
): ApiSuccessEnvelope<TData | null> {
  return {
    code: SUCCESS_CODE,
    // §1.5：可选字段缺省返回 null，不返回 undefined（JSON 会丢字段，前端类型就对不上了）
    data: data ?? null,
    error: null,
    message: SUCCESS_MESSAGE,
  };
}

export function toErrorEnvelope(input: {
  message: string;
  errorCode: string;
}): ApiErrorEnvelope {
  const message =
    input.message.trim() === '' ? INTERNAL_ERROR_MESSAGE : input.message;
  return {
    code: FAILURE_CODE,
    data: null,
    error: message,
    errorCode: input.errorCode,
    message,
  };
}

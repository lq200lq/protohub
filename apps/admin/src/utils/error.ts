/**
 * 请求层错误 → 人话字符串。
 * requestClient 失败时抛出的是响应体（ApiEnvelope）或 Error，
 * 类型不稳定，视图里需要把它收成字符串交给 DataState 展示。
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { error?: string; message?: string };
    return maybe.error ?? maybe.message ?? '';
  }
  return '';
}

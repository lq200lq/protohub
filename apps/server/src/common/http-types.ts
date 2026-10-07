/**
 * 请求/响应的**结构化**最小视图。
 *
 * 为什么不直接 import `fastify` 的类型：`fastify` 不是本包的依赖（由
 * `@nestjs/platform-fastify` 带进来），本包 node_modules 里没有它；
 * 只声明用到的一两个方法，既不用 `any` 也不会把适配器类型泄漏进业务代码。
 */

/** 只读请求里用得上的字段。 */
export interface HttpRequestLike {
  readonly headers: Record<string, unknown>;
  readonly method?: string;
  readonly url?: string;
}

/** 中间件会把 traceId 挂回请求对象：异常过滤器运行在 ALS 之外，只能从这里取。 */
export interface TraceableRequest extends HttpRequestLike {
  traceId?: string;
}

/** 能写响应头的对象。 */
export interface ResponseHeaderWriter {
  header?: (name: string, value: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
}

/** 异常过滤器需要的响应能力：设状态码 + 发体。FastifyReply 的 `status()` 是 `code()` 的别名。 */
export interface HttpReplyLike extends ResponseHeaderWriter {
  status(code: number): unknown;
  send(body: unknown): unknown;
}

export function setResponseHeader(
  reply: ResponseHeaderWriter,
  name: string,
  value: string,
): void {
  if (reply.header) {
    reply.header(name, value);
    return;
  }
  reply.setHeader?.(name, value);
}

function firstHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const [first] = value.filter((item): item is string => typeof item === 'string');
    return first;
  }
  return undefined;
}

/**
 * 取请求头。Node 的 `req.headers` 键已小写，这里再兼容一次大小写，
 * 免得换成别的适配器就静默读不到。
 */
export function readRequestHeader(
  request: HttpRequestLike,
  name: string,
): string | undefined {
  const headers = request.headers ?? {};
  const direct = firstHeaderValue(headers[name]);
  if (direct !== undefined) {
    return direct;
  }
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      return firstHeaderValue(headers[key]);
    }
  }
  return undefined;
}

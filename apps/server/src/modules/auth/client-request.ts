/**
 * 客户端信息提取（写 sys_login_log 用）。
 *
 * 只声明用到的字段：`fastify` 不是本包的直接依赖，引它的类型会把适配器细节漏进业务代码。
 */
export interface ClientRequestLike {
  readonly ip?: string;
  readonly headers?: Record<string, unknown>;
}

/** 登录日志要记的两个客户端字段。 */
export interface ClientMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** 从请求里一次取全审计要用的客户端信息。 */
export function clientMetaOf(request: ClientRequestLike): ClientMeta {
  return { ip: clientIpOf(request), userAgent: userAgentOf(request) };
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{1,5})?$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * 归一化成 `inet` 列能收的值。
 *
 * 必须做这步：`sys_login_log.ip` 是 PostgreSQL 的 `inet`，塞进 `"unknown"` 这类脏值会让
 * 整条日志插入失败——登录不该被审计写入拖垮。
 */
export function normalizeIp(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (trimmed.startsWith('::ffff:') && IPV4.test(trimmed.slice(7))) {
    return trimmed.slice(7);
  }
  if (IPV4.test(trimmed) || (IPV6.test(trimmed) && trimmed.includes(':'))) {
    return trimmed;
  }
  return null;
}

function headerValue(
  request: ClientRequestLike,
  name: string,
): string | undefined {
  const raw = request.headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** nginx 反代时真实来源在 `X-Real-IP`（部署与运维方案 §5.1），直连时回落 socket 地址。 */
export function clientIpOf(request: ClientRequestLike): string | null {
  const forwarded = headerValue(request, 'x-forwarded-for');
  const candidates = [
    headerValue(request, 'x-real-ip'),
    forwarded?.split(',')[0]?.trim(),
    request.ip,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeIp(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function userAgentOf(request: ClientRequestLike): string | null {
  const agent = headerValue(request, 'user-agent');
  return agent ? agent.slice(0, 500) : null;
}

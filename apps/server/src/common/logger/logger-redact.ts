import {
  REDACTED_PLACEHOLDER,
  SENSITIVE_KEY_PATTERNS,
} from '../../config/constants';

/** 日志里最大展开深度，超了就用占位符截断（防御自引用/超深结构）。 */
const MAX_LOG_DEPTH = 8;

/** 字段名包含 `*secret*`、`password`、`token`、`authorization` 之一即视为敏感（大小写不敏感）。 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isRecord(value: object): value is Record<string, unknown> {
  return !Array.isArray(value);
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
    return type === 'bigint' ? value.toString() : value;
  }
  if (type === 'function') {
    return `[Function ${(value as { name?: string }).name ?? 'anonymous'}]`;
  }
  if (type !== 'object') {
    return String(value);
  }

  const objectValue = value as object;
  if (objectValue instanceof Error) {
    return { name: objectValue.name, message: objectValue.message };
  }
  if (depth >= MAX_LOG_DEPTH || seen.has(objectValue)) {
    return depth >= MAX_LOG_DEPTH ? '[Truncated]' : '[Circular]';
  }
  seen.add(objectValue);

  if (Array.isArray(objectValue)) {
    return objectValue.map((item) => redact(item, depth + 1, seen));
  }
  if (!isRecord(objectValue)) {
    return String(value);
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(objectValue)) {
    output[key] = isSensitiveKey(key)
      ? REDACTED_PLACEHOLDER
      : redact(item, depth + 1, seen);
  }
  return output;
}

/** 递归脱敏：返回可安全 JSON 序列化的结构，敏感字段换成占位符。 */
export function redactValue(value: unknown): unknown {
  return redact(value, 0, new WeakSet<object>());
}

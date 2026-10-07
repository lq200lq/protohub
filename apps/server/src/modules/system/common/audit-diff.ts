import type { Prisma } from '@prisma/client';

/**
 * 审计日志的变更差异构造与脱敏（数据库设计 §4.1.9 的硬约束 + 迭代实施计划 §3.7"审计必须脱敏"）。
 *
 * 三条红线：
 * 1. 不写 password_hash / 密码明文 / refreshToken / 完整 accessToken——字段名命中敏感特征一律替换；
 * 2. 密码类变更只记 `{ password_changed: true }`（连 hash 前缀都不留）；
 * 3. 只记**变化了**的字段，未变的字段不进 detail（日志是给人查的，不是镜像表）。
 */

/** 命中即脱敏的字段名特征（大小写不敏感的子串匹配，与 common/logger 的特征表同源再加宽）。 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'refresh',
  'sess',
];

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** 只有 JSON 里能安全落地的值；显式建模而不是 unknown，让 detail 的类型天然排斥函数/Symbol 等。 */
export type AuditValue =
  | null
  | string
  | number
  | boolean
  | AuditValue[]
  | { [key: string]: AuditValue };

export type AuditObject = { [key: string]: AuditValue };

export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/**
 * 递归脱敏：数组逐项、对象逐键；命中敏感字段名的值整体替换，不做部分打码（部分打码仍可能泄露 hash 前缀）。
 *
 * 布尔值例外：`{ password_changed: true }` 是 §4.1.9 唯一认可的密码变更形态，它本身不含任何秘密，
 * 打成 `[REDACTED]` 反而把"改过密码"这个事实抹掉了。字符串/数字才可能是泄露物。
 */
export function redactAuditValue(value: AuditValue): AuditValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuditValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: AuditValue } = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        isSensitiveKey(key) && typeof item !== 'boolean'
          ? REDACTED_PLACEHOLDER
          : redactAuditValue(item);
    }
    return out;
  }
  return value;
}

/** 敏感字段名过滤后的对象浅拷贝（用于"值已经是字符串、不能整体替换"的场景）。 */
export function omitSensitiveKeys<T extends object>(record: T): AuditObject {
  const out: AuditObject = {};
  for (const [key, value] of Object.entries(record)) {
    // 布尔值例外与 redactAuditValue 同一条（§4.1.9）：`{password_changed: true}` 不是秘密，
    // 打码反而把"改过密码"这个事实抹掉。两条脱敏路径必须同判——同一个 detail 从不同入口进来
    // 结果不同，审计就不可信（M5-T5 抽查时在 dev 库 4 条 change_password 行上真见过 `[REDACTED]`）。
    if (isSensitiveKey(key) && typeof value !== 'boolean') {
      out[key] = REDACTED_PLACEHOLDER;
      continue;
    }
    out[key] = toAuditValue(value);
  }
  return out;
}

/** 把业务值收敛成 AuditValue：Date → ISO 串，BigInt → 十进制串，其它不支持的类型记 `[unserializable]`。 */
export function toAuditValue(value: unknown): AuditValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toAuditValue(item));
  }
  if (typeof value === 'object') {
    return omitSensitiveKeys(value as Record<string, unknown>);
  }
  return '[unserializable]';
}

/**
 * before/after 差异。`fields` 指定参与比较的键（缺省取两侧键的并集）。
 * 输出 `{ before: {仅变化项}, after: {仅变化项} }`；没有差异时返回 null，调用方据此跳过 detail。
 */
export function buildChangeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): AuditObject | null {
  const keys =
    fields ??
    [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const beforeChanged: AuditObject = {};
  const afterChanged: AuditObject = {};
  for (const key of keys) {
    // 两侧都按 JSON 可比形态归一化后再比，否则 Date 与它的 ISO 串会被误判成"变更"。
    const previous = toAuditValue(before[key]);
    const next = toAuditValue(after[key]);
    if (auditValueEquals(previous, next)) {
      continue;
    }
    beforeChanged[key] = previous;
    afterChanged[key] = next;
  }
  if (Object.keys(afterChanged).length === 0) {
    return null;
  }
  return {
    before: redactAuditValue(beforeChanged),
    after: redactAuditValue(afterChanged),
  };
}

function auditValueEquals(left: AuditValue, right: AuditValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

/** 键排序后序列化，保证 `{a:1,b:2}` 与 `{b:2,a:1}` 判定为相等。 */
function stableStringify(value: AuditValue): string {
  return JSON.stringify(sortValue(value)) ?? 'null';
}

function sortValue(value: AuditValue): AuditValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: AuditValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        out[key] = sortValue(item);
      }
    }
    return out;
  }
  return value;
}

/** 授权集合类变更（角色/权限码/菜单）：记增删 + 两侧全集，日志既可读又能复盘。 */
export function buildSetDiff(
  before: readonly string[],
  after: readonly string[],
): AuditObject {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((item) => !beforeSet.has(item)).sort(),
    removed: before.filter((item) => !afterSet.has(item)).sort(),
    before: [...before].sort(),
    after: [...after].sort(),
  };
}

/** §4.1.9 唯一认可的密码变更形态。 */
export function passwordChangedDetail(): AuditObject {
  return { password_changed: true };
}

/** 删除类操作保留被删对象快照（否则记录被软删后无法复盘"当初删了谁"）。 */
export function snapshotDetail(snapshot: Record<string, unknown>): AuditObject {
  return { snapshot: omitSensitiveKeys(snapshot) };
}

/**
 * 落库前的最后一道转换。`as Prisma.InputJsonValue` 这个断言是安全的：
 * 值已经过 redactAuditValue/toAuditValue，只可能是 JSON 原生类型（无函数、无 undefined、无循环引用）。
 */
export function toInputJson(value: AuditValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

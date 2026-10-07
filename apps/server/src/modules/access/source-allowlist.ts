const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV6_GROUPS = 8;

interface IpValue {
  readonly bitLength: number;
  readonly bits: bigint;
}

function ipv4ToBits(text: string): IpValue | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8n) + BigInt(octet);
  }
  return { bitLength: IPV4_BITS, bits: value };
}

/** IPv6 的一组：1-4 位十六进制。 */
function ipv6Group(value: string): bigint | null {
  if (!/^[0-9a-fA-F]{1,4}$/.test(value)) {
    return null;
  }
  return BigInt(`0x${value}`);
}

function ipv6ToBits(text: string): IpValue | null {
  const lower = text.toLowerCase();
  // `::ffff:127.0.0.1` 这类映射形态按 IPv4 处理：nginx 双栈监听时 `$remote_addr` 就是这么来的，
  // 如果把它当独立的 128 位值，白名单里写的 `127.0.0.1/32` 就永远匹配不上。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) {
    return ipv4ToBits(mapped[1]);
  }
  if (!lower.includes(':')) {
    return null;
  }
  const parts = lower.split('::');
  // `::` 至多出现一次（`1:2::3::4` 是畸形地址）
  if (parts.length > 2) {
    return null;
  }
  const head: bigint[] = [];
  const tail: bigint[] = [];
  const fill = (segmentText: string, into: bigint[]): boolean => {
    if (segmentText === '') {
      return true;
    }
    for (const segment of segmentText.split(':')) {
      // 尾段允许是点分 IPv4（`64:ff9b::192.0.2.1` 这种 NAT64 形态），占两组
      if (segment.includes('.')) {
        const inner = ipv4ToBits(segment);
        if (!inner) {
          return false;
        }
        into.push(inner.bits >> 16n, inner.bits & 0xffffn);
        continue;
      }
      const value = ipv6Group(segment);
      if (value === null) {
        return false;
      }
      into.push(value);
    }
    return true;
  };
  if (!fill(parts[0] ?? '', head)) {
    return null;
  }
  if (parts.length === 2 && !fill(parts[1] ?? '', tail)) {
    return null;
  }

  // `::` 省略的是**中间**那段零组，组数由剩下的两侧推出：`::1` 是 7 组零 + 1，不是 1 + 7 组零。
  // 两侧本来就写超了 8 组（`1:2:3:4:5:6:7:8:9::`）时补不出合法长度，由下面的校验拒掉。
  const zeros = Math.max(0, IPV6_GROUPS - head.length - tail.length);
  const groups =
    parts.length === 2
      ? [...head, ...Array.from({ length: zeros }, () => 0n), ...tail]
      : head;
  if (groups.length !== IPV6_GROUPS) {
    return null;
  }

  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) + group;
  }
  return { bitLength: IPV6_BITS, bits: value };
}

function parseIp(text: string): IpValue | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.includes(':') ? ipv6ToBits(trimmed) : ipv4ToBits(trimmed);
}

function parseCidr(
  entry: string,
): { readonly prefix: number; readonly network: IpValue } | null {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf('/');
  const network = parseIp(slash === -1 ? trimmed : trimmed.slice(0, slash));
  if (!network) {
    return null;
  }
  if (slash === -1) {
    return { network, prefix: network.bitLength };
  }
  const prefixText = trimmed.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) {
    return null;
  }
  const prefix = Number(prefixText);
  if (prefix > network.bitLength) {
    return null;
  }
  return { network, prefix };
}

function masked(value: IpValue, prefix: number): bigint {
  return value.bits >> BigInt(value.bitLength - prefix);
}

/**
 * 来源白名单判定（[迭代实施计划.md](../../../../../docs/迭代实施计划.md) M4-T3 的 C3；
 * [后端接口设计.md](../../../../../docs/后端接口设计.md) §9.1「拒绝公网来源」）。
 *
 * 为什么手写而不装 `ip-cidr`：这里需要的只有"IP 是否属于某个 CIDR"，而计划 §3.2 的依赖白名单
 * 不为一个三十行的位运算开新依赖；并且任何来源判定失败都必须**保守拒绝**，自己写的实现能一眼看完。
 *
 * 只信 `X-Real-IP`（nginx 用 `$remote_addr` 覆盖写），**不信 `X-Forwarded-For`**：
 * 后者第一段可由客户端伪造（机制 §6 的 IP 处理）。
 */
export function isAllowedSource(
  ip: string | undefined,
  allowCidrs: readonly string[],
): boolean {
  const value = ip === undefined ? null : parseIp(ip);
  if (!value) {
    return false;
  }
  return allowCidrs.some((entry) => {
    const rule = parseCidr(entry);
    // 族必须相同再比前缀：IPv4 的 32 位与 IPv6 的 128 位混在一起，位移会算出负数（配置写错族
    // 也只会变成"匹配不上"，而不是"意外放行"）。
    if (rule === null || rule.network.bitLength !== value.bitLength) {
      return false;
    }
    return masked(value, rule.prefix) === masked(rule.network, rule.prefix);
  });
}

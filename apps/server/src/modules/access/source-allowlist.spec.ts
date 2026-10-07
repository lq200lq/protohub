import { describe, expect, it } from 'vitest';

import { isAllowedSource } from './source-allowlist';

/**
 * 来源白名单单测（计划 M4-T3 的 C3：非内网 `X-Real-IP` → 403）。
 * 这条判定挡的是"把 `/api/access/check` 当权限探测 API 用"，所以任何解析失败都必须**拒绝**。
 */
const LAN = ['127.0.0.1/32', '10.0.0.0/8', '192.168.0.0/16', '::1/128', 'fd00::/8'];

describe('isAllowedSource：CIDR 命中判定', () => {
  it('默认配置（127.0.0.1/32）只放本机，公网地址一律拒', () => {
    expect(isAllowedSource('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(isAllowedSource('8.8.8.8', ['127.0.0.1/32'])).toBe(false);
    expect(isAllowedSource('127.0.0.2', ['127.0.0.1/32'])).toBe(false);
  });

  it('网段按前缀折叠：10.1.2.3 属于 10.0.0.0/8，11.x 不属于', () => {
    expect(isAllowedSource('10.1.2.3', LAN)).toBe(true);
    expect(isAllowedSource('192.168.99.1', LAN)).toBe(true);
    expect(isAllowedSource('192.169.99.1', LAN)).toBe(false);
    expect(isAllowedSource('11.0.0.1', LAN)).toBe(false);
  });

  it('边界值不算漂移：/8 的最后一号与下一号', () => {
    expect(isAllowedSource('10.255.255.255', ['10.0.0.0/8'])).toBe(true);
    expect(isAllowedSource('11.0.0.0', ['10.0.0.0/8'])).toBe(false);
  });

  it('不带斜杠的条目按"这一个地址"处理（开发时手写本机 IP 的常见写法）', () => {
    expect(isAllowedSource('10.0.0.5', ['10.0.0.5'])).toBe(true);
    expect(isAllowedSource('10.0.0.6', ['10.0.0.5'])).toBe(false);
  });

  it('/0 是全通，用于"前面还有一层 CDN"的部署（部署方案 §5）', () => {
    expect(isAllowedSource('203.0.113.7', ['0.0.0.0/0'])).toBe(true);
    expect(isAllowedSource('8.8.8.8', LAN)).toBe(false);
  });

  it('IPv6 环回与 ULA 段各自命中，压缩写法 ::1 与全写 0:0:0:0:0:0:0:1 等价', () => {
    expect(isAllowedSource('::1', LAN)).toBe(true);
    expect(isAllowedSource('0:0:0:0:0:0:0:1', LAN)).toBe(true);
    expect(isAllowedSource('::2', LAN)).toBe(false);
    expect(isAllowedSource('fd12:3456::1', LAN)).toBe(true);
    expect(isAllowedSource('fe12:3456::1', LAN)).toBe(false);
  });

  it('双栈监听时 nginx 给的 ::ffff:127.0.0.1 要能命中 127.0.0.1/32（映射形态按 IPv4 处理）', () => {
    expect(isAllowedSource('::ffff:127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(isAllowedSource('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isAllowedSource('::ffff:8.8.8.8', ['127.0.0.1/32'])).toBe(false);
  });

  it('族不同不互认：IPv6 的条目匹配不上 IPv4 的请求（配置写错族只会拒，不会意外放行）', () => {
    expect(isAllowedSource('127.0.0.1', ['::ffff:0:0/0'])).toBe(false);
    expect(isAllowedSource('::1', ['0.0.0.0/0'])).toBe(false);
  });

  it('缺头、空值、畸形 IP、畸形条目一律拒绝（探测接口不该拿到任何信息）', () => {
    for (const ip of [undefined, '', '  ', 'localhost', '127.0.0.1:8080', '256.0.0.1', '127.0.0', '10.1.2.3.4', '10.1.2.x']) {
      expect(isAllowedSource(ip, LAN), String(ip)).toBe(false);
    }
    for (const entry of ['', 'abc/32', '10.0.0.0/33', '10.0.0.0/x', '10.0.0.0/', '::/129', '127.0.0.1/-1']) {
      expect(isAllowedSource('127.0.0.1', [entry]), entry).toBe(false);
    }
  });

  it('空白名单等于全拒（配置被清空时不能退化成"公开可达"）', () => {
    expect(isAllowedSource('127.0.0.1', [])).toBe(false);
  });

  it('带空格与大小写的条目也能用（环境变量是人手写的）', () => {
    expect(isAllowedSource('10.1.2.3', [' 10.0.0.0/8 '])).toBe(true);
    expect(isAllowedSource('FD00::1', ['fd00::/8'])).toBe(true);
  });
});

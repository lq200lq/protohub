import { Injectable } from '@nestjs/common';

import { AppEnvService } from '../../config/app-env.service';

/**
 * 两个 HttpOnly Cookie 的名字与属性（权限模型设计 §5.1、后端接口设计 §2.1）。
 * 常量放这里：M4 的 `/access/check` 要靠 `proto_sess` 认身份，必须用同一个名字。
 */
export const REFRESH_COOKIE_NAME = 'proto_refresh';
export const SESSION_COOKIE_NAME = 'proto_sess';

/** refresh Cookie 只服务 /auth/*，把它的作用域缩到最小，别让它跟着静态资源请求外发。 */
export const REFRESH_COOKIE_PATH = '/api/auth';
export const SESSION_COOKIE_PATH = '/';

/**
 * 密码档解锁 Cookie 的名字前缀（接口设计 §9.2）：`proto_access_p{原型数字ID}`。
 * 用 ID 而不是「项目码-原型码」：编码里允许 `-`，拼接形式会撞名（`a-b`+`c` 与 `a`+`b-c` 同形），
 * 而数字 ID 全局唯一、不歧义，也不会把业务编码写进 Cookie 名。
 */
export const ACCESS_COOKIE_PREFIX = 'proto_access_p';

export function accessCookieName(prototypeId: string): string {
  return `${ACCESS_COOKIE_PREFIX}${prototypeId}`;
}

export interface CookieWriteOptions {
  readonly path: string;
  readonly maxAgeSeconds: number;
}

/** 只用得到的那一个能力：写响应头（FastifyReply 结构上满足）。 */
export interface CookieReplyWriter {
  header(name: string, value: string | readonly string[]): unknown;
}

function readCookieHeader(request: unknown): string | undefined {
  const headers = (request as { headers?: Record<string, unknown> })?.headers;
  const raw = headers?.['cookie'] ?? headers?.['Cookie'];
  // 代理/测试里偶尔能见到数组形态，用 ';' 拼起来再解析，免得整头被当成第一段丢掉。
  if (Array.isArray(raw)) {
    const parts = raw.filter((item): item is string => typeof item === 'string');
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name !== '' && !(name in cookies)) {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

/**
 * Cookie 读写。
 *
 * 为什么手写而不装 `@fastify/cookie`：注册插件要改 `main.ts`（不在本次改动范围内），
 * 而这里只需要"读一个头 + 写两个头"。多个 `Set-Cookie` 必须在**同一次** `header()` 调用里
 * 传数组，Fastify 存的是对象，第二次调用会覆盖第一次。
 */
@Injectable()
export class CookieService {
  constructor(private readonly env: AppEnvService) {}

  read(request: unknown, name: string): string | undefined {
    const header = readCookieHeader(request);
    if (!header) {
      return undefined;
    }
    return parseCookieHeader(header)[name];
  }

  serialize(
    name: string,
    value: string,
    options: CookieWriteOptions,
  ): string {
    const segments = [
      `${name}=${value}`,
      `Path=${options.path}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${options.maxAgeSeconds}`,
    ];
    // Secure 只由 NODE_ENV 推导：开发跑 http，带 Secure 的话浏览器根本不存。
    if (this.env.env.cookie.secure) {
      segments.push('Secure');
    }
    return segments.join('; ');
  }

  /** 登录/刷新成功后一次性下发两个 Cookie。 */
  issueAuthCookies(
    reply: CookieReplyWriter,
    tokens: {
      refreshToken: string;
      sessionToken: string;
      refreshMaxAgeSeconds: number;
      sessionMaxAgeSeconds: number;
    },
  ): void {
    reply.header('set-cookie', [
      this.serialize(REFRESH_COOKIE_NAME, tokens.refreshToken, {
        path: REFRESH_COOKIE_PATH,
        maxAgeSeconds: tokens.refreshMaxAgeSeconds,
      }),
      this.serialize(SESSION_COOKIE_NAME, tokens.sessionToken, {
        path: SESSION_COOKIE_PATH,
        maxAgeSeconds: tokens.sessionMaxAgeSeconds,
      }),
    ]);
  }

  /** 清除时必须带上同名同 Path，否则浏览器删不掉。 */
  clearAuthCookies(reply: CookieReplyWriter): void {
    reply.header('set-cookie', [
      this.serialize(REFRESH_COOKIE_NAME, '', {
        path: REFRESH_COOKIE_PATH,
        maxAgeSeconds: 0,
      }),
      this.serialize(SESSION_COOKIE_NAME, '', {
        path: SESSION_COOKIE_PATH,
        maxAgeSeconds: 0,
      }),
    ]);
  }
}

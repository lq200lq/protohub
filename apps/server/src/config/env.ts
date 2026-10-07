import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

import { DEFAULT_MAX_UPLOAD_BYTES } from '@protohub/shared';

import {
  SECRET_ENV_KEYS,
  SECRET_MIN_LENGTH,
  STORAGE_SUBDIRS,
  type SecretEnvKey,
  type StorageSubdir,
} from './constants';

export type NodeEnv = 'development' | 'test' | 'production';

/** `SERVE_STATIC=node` 时由 Node 直出静态产物（开发无 nginx），见 平台设计方案.md §5。 */
export type ServeStaticMode = 'node' | 'nginx';

export type PinoLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** 校验通过后的配置视图：按用途分组，业务代码只读它，不再直接碰 process.env。 */
export interface AppEnv {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
  };
  readonly db: { readonly url: string };
  readonly storage: {
    readonly driver: 'local';
    readonly root: string;
    readonly subdirs: readonly StorageSubdir[];
  };
  readonly serveStatic: ServeStaticMode;
  readonly secrets: {
    readonly jwtAccess: string;
    readonly jwtRefresh: string;
    readonly sessionCookie: string;
    readonly accessToken: string;
  };
  readonly jwt: {
    readonly accessTokenTtl: string;
    readonly refreshTokenTtl: string;
    readonly unlockTokenTtl: string;
  };
  readonly cookie: { readonly secure: boolean };
  readonly upload: {
    readonly maxBytes: number;
    readonly maxEntries: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly maxRatio: number;
  };
  readonly release: {
    readonly maxConcurrentTasks: number;
    readonly keepRecentReleases: number;
    readonly keepMinDays: number;
    readonly trashTtlDays: number;
  };
  readonly retention: {
    readonly accessLogKeepDays: number;
    readonly taskKeepDays: number;
  };
  readonly access: { readonly checkAllowCidrs: readonly string[] };
  readonly logLevel: PinoLogLevel;
}

/** 启动期配置错误：一次性列出所有问题，并直接说明怎么修。 */
export class EnvConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      [
        'ProtoHub 服务端启动被拒绝：环境变量配置不完整或不合法。',
        ...problems.map((problem) => `  ✗ ${problem}`),
        '开发环境请检查 apps/server/.env.development（约定见 docs/部署与运维方案.md §2、docs/迭代实施计划.md §3.3）。',
      ].join('\n'),
    );
    this.name = 'EnvConfigError';
    this.problems = problems;
  }
}

/**
 * 四个密钥没有代码级默认值：缺失就是一句人话报错，而不是 `undefined` 一路飘到运行时。
 */
function secretField(name: SecretEnvKey): z.ZodString {
  return z
    .string({
      required_error: `${name} 缺失：四个密钥一律不给默认值，请用 openssl rand -base64 48 生成后写入环境变量`,
      invalid_type_error: `${name} 必须是字符串`,
    })
    .min(
      SECRET_MIN_LENGTH,
      `${name} 长度不足 ${SECRET_MIN_LENGTH} 字符，疑似示例值（生产环境绝不能用示例值）`,
    );
}

const rawEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string({ required_error: 'HOST 缺失，开发值 127.0.0.1' }).min(1),
    PORT: z.coerce
      .number({ invalid_type_error: 'PORT 必须是数字' })
      .int()
      .min(1)
      .max(65_535),
    DATABASE_URL: z
      .string({ required_error: 'DATABASE_URL 缺失' })
      .regex(/^postgresql:\/\/\S+$/, 'DATABASE_URL 必须是 postgresql:// 开头的连接串'),
    PUBLIC_BASE_URL: z
      .string({ required_error: 'PUBLIC_BASE_URL 缺失' })
      .regex(/^https?:\/\/\S+$/, 'PUBLIC_BASE_URL 必须是 http(s) 绝对地址'),
    STORAGE_ROOT: z.string({ required_error: 'STORAGE_ROOT 缺失' }).min(1),
    SERVE_STATIC: z.enum(['node', 'nginx'], {
      errorMap: () => ({ message: 'SERVE_STATIC 只能是 node 或 nginx' }),
    }),
    JWT_ACCESS_SECRET: secretField('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secretField('JWT_REFRESH_SECRET'),
    SESSION_COOKIE_SECRET: secretField('SESSION_COOKIE_SECRET'),
    ACCESS_TOKEN_SECRET: secretField('ACCESS_TOKEN_SECRET'),
    ACCESS_TOKEN_TTL: z.string().min(1).default('2h'),
    REFRESH_TOKEN_TTL: z.string().min(1).default('7d'),
    UNLOCK_TOKEN_TTL: z.string().min(1).default('24h'),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_UPLOAD_BYTES),
    MAX_ENTRIES: z.coerce.number().int().positive().default(5_000),
    MAX_FILE_BYTES: z.coerce.number().int().positive().default(209_715_200),
    MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(524_288_000),
    MAX_RATIO: z.coerce.number().int().positive().default(1_000),
    MAX_CONCURRENT_TASKS: z.coerce.number().int().positive().default(1),
    KEEP_RECENT_RELEASES: z.coerce.number().int().positive().default(5),
    KEEP_MIN_DAYS: z.coerce.number().int().min(0).default(30),
    TRASH_TTL_DAYS: z.coerce.number().int().min(0).default(7),
    ACCESS_LOG_KEEP_DAYS: z.coerce.number().int().positive().default(180),
    TASK_KEEP_DAYS: z.coerce.number().int().positive().default(90),
    ACCESS_CHECK_ALLOW_CIDRS: z.string().min(1).default('127.0.0.1/32'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
  .superRefine((value, ctx) => {
    // localhost 会同时解析到 ::1，同端口若被别的进程占了一族地址，请求会打到别人身上（迭代实施计划 §3.1）
    if (value.HOST.trim().toLowerCase() === 'localhost') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HOST'],
        message: 'HOST 不能填 localhost（会同时解析到 ::1），请填 127.0.0.1',
      });
    }

    const seen: Array<readonly [SecretEnvKey, string]> = [];
    for (const entry of SECRET_ENV_KEYS.map(
      (key) => [key, value[key]] as const,
    )) {
      const [key, secret] = entry;
      const clash = seen.find(
        ([, previousSecret]) => previousSecret === secret,
      );
      if (clash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} 与 ${clash[0]} 的值相同：四个密钥必须两两不同，否则一处泄露就能顶掉另一处的信任边界`,
        });
      }
      seen.push(entry);
    }
  });

/**
 * Cookie 的 `Secure` 只能由 NODE_ENV 推导：开发跑 http，带 Secure 的 Cookie 浏览器根本不保存，
 * refresh 与 member 档访问会静默失效（迭代实施计划 §3.3 第一条差异）。
 */
export function deriveCookieSecure(nodeEnv: NodeEnv): boolean {
  return nodeEnv === 'production';
}

/** 允许 `~` 写法（部署与运维方案.md 用绝对路径，开发用家目录）。 */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.');
  return `${path === '' ? '环境变量' : path}：${issue.message}`;
}

/** 校验并归一化；任何一条不满足都抛 EnvConfigError，让启动直接失败。 */
export function parseEnv(raw: Record<string, unknown>): AppEnv {
  const result = rawEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvConfigError(result.error.issues.map(formatIssue));
  }
  const value = result.data;

  return {
    nodeEnv: value.NODE_ENV,
    isProduction: value.NODE_ENV === 'production',
    http: {
      host: value.HOST.trim(),
      port: value.PORT,
      publicBaseUrl: value.PUBLIC_BASE_URL.trim().replace(/\/+$/, ''),
    },
    db: { url: value.DATABASE_URL.trim() },
    storage: {
      driver: 'local',
      root: expandUserPath(value.STORAGE_ROOT),
      subdirs: STORAGE_SUBDIRS,
    },
    serveStatic: value.SERVE_STATIC,
    secrets: {
      jwtAccess: value.JWT_ACCESS_SECRET,
      jwtRefresh: value.JWT_REFRESH_SECRET,
      sessionCookie: value.SESSION_COOKIE_SECRET,
      accessToken: value.ACCESS_TOKEN_SECRET,
    },
    jwt: {
      accessTokenTtl: value.ACCESS_TOKEN_TTL,
      refreshTokenTtl: value.REFRESH_TOKEN_TTL,
      unlockTokenTtl: value.UNLOCK_TOKEN_TTL,
    },
    cookie: { secure: deriveCookieSecure(value.NODE_ENV) },
    upload: {
      maxBytes: value.MAX_UPLOAD_BYTES,
      maxEntries: value.MAX_ENTRIES,
      maxFileBytes: value.MAX_FILE_BYTES,
      maxTotalBytes: value.MAX_TOTAL_BYTES,
      maxRatio: value.MAX_RATIO,
    },
    release: {
      maxConcurrentTasks: value.MAX_CONCURRENT_TASKS,
      keepRecentReleases: value.KEEP_RECENT_RELEASES,
      keepMinDays: value.KEEP_MIN_DAYS,
      trashTtlDays: value.TRASH_TTL_DAYS,
    },
    retention: {
      accessLogKeepDays: value.ACCESS_LOG_KEEP_DAYS,
      taskKeepDays: value.TASK_KEEP_DAYS,
    },
    access: {
      checkAllowCidrs: value.ACCESS_CHECK_ALLOW_CIDRS.split(',')
        .map((cidr) => cidr.trim())
        .filter((cidr) => cidr !== ''),
    },
    logLevel: value.LOG_LEVEL,
  };
}

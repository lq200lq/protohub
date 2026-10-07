import { ERROR_CODES, type PageQuery } from '@protohub/shared';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import {
  normalizePageQuery,
  type NormalizedPageQuery,
} from '../../../common/pagination/pagination';
import { BusinessException } from '../../../common/exception/business.exception';

/**
 * zod → Nest 管道的桥。
 *
 * 为什么不用全局 ValidationPipe：class-validator 那套依赖装饰器元数据与 DTO class，而
 * 迭代实施计划 §3.5 把校验契约放在了 zod schema（前后端共用一份形态定义）。
 * 这里只做一件事：把 zod 的 issue 列表翻译成人话（进 `error`），并挂上 PARAM_INVALID（进 `errorCode`），
 * 保证与 后端接口设计 §1.2/§1.4 的约定一致——400 + 人话，不是 500。
 */
export function zodValidationPipe<TShape extends z.ZodTypeAny>(
  schema: TShape,
): PipeTransform<unknown, z.infer<TShape>> {
  return {
    transform(value: unknown): z.infer<TShape> {
      const result = schema.safeParse(value);
      if (result.success) {
        return result.data;
      }
      throw invalidArguments(result.error);
    },
  };
}

/** 直接校验（服务层与单测用，绕开 Nest 管道）。 */
export function parseWithSchema<TShape extends z.ZodTypeAny>(
  schema: TShape,
  value: unknown,
): z.infer<TShape> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  throw invalidArguments(result.error);
}

function invalidArguments(error: z.ZodError): BusinessException {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}：${issue.message}`)
    .join('；');
  return new BusinessException(
    `参数不合法：${details}`,
    ERROR_CODES.PARAM_INVALID,
    400,
  );
}

/**
 * query 里的布尔/数字都是字符串。这几个 helper 负责把 '' 视为"没填"，
 * 否则 `?success=` 会被 coerce 成 false，把筛选条件悄悄改成"只看失败"。
 *
 * 返回类型统一写成 `QuerySchema<T>`（input 侧是 unknown，因为 HTTP query 什么都能进来）：
 * 直接写 `z.ZodOptional<string>` 之类的具体类型在 zod 里是不成立的泛型参数（ZodOptional 的
 * 类型参数必须是 ZodTypeAny），而 `ZodType<T, def, T>` 又会拒绝 preprocess 的 unknown 入口。
 */
export type QuerySchema<TValue> = z.ZodType<TValue, z.ZodTypeDef, unknown>;

function blankToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

export const optionalQueryText = (max = 120): QuerySchema<string | undefined> =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).max(max).optional(),
  );

/**
 * 表示 id 的请求体字段：一律十进制字符串（bigint 超出 JS 安全整数，number 会丢精度）。
 * 与 `parseIdParam`（路径参数）成对；query 里的可选版本是 `optionalQueryId`。
 */
export const idStringField = (label = 'id'): z.ZodString =>
  z.string().trim().regex(/^\d{1,19}$/, `${label} 必须是数字字符串`);

export const optionalQueryBoolean = (): QuerySchema<boolean | undefined> =>
  z.preprocess(
    blankToUndefined,
    z
      .union([z.boolean(), z.enum(['true', 'false', '0', '1'])])
      .transform((value) => value === true || value === 'true' || value === '1')
      .optional(),
  );

export const optionalQueryId = (): QuerySchema<string | undefined> =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .regex(/^\d{1,19}$/, 'id 必须是数字字符串')
      .optional(),
  );

/** ISO 8601 时间（后端接口设计 §1.1：入参时间一律带时区的 ISO 串）。 */
export const optionalQueryDateTime = (): QuerySchema<Date | undefined> =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine((value) => Number.isFinite(Date.parse(value)), '时间必须是 ISO 8601 格式')
      .transform((value) => new Date(Date.parse(value)))
      .optional(),
  );

/** query 里的可选整数（分页之外的数字筛选用；'' 同样视为未填）。 */
export const optionalQueryInteger = (
  constraint?: { readonly min?: number; readonly max?: number },
): QuerySchema<number | undefined> =>
  z.preprocess(
    blankToUndefined,
    z.coerce
      .number()
      .int('必须是整数')
      .min(constraint?.min ?? -Number.MAX_SAFE_INTEGER)
      .max(constraint?.max ?? Number.MAX_SAFE_INTEGER)
      .optional(),
  );

/**
 * 分页参数走公共归一化（默认 20 / 上限 200 的夹取规则只在一处实现，见 后端接口设计 §1.3/§1.5）。
 * 这里把原始 query 里 page/pageSize/sortBy/sortOrder 抽出来交给它。
 */
export function pageQueryFrom(query: PageQuery | Record<string, unknown>): NormalizedPageQuery {
  const source = query as Record<string, unknown>;
  return normalizePageQuery({
    page: source['page'],
    pageSize: source['pageSize'],
    sortBy: source['sortBy'],
    sortOrder: source['sortOrder'],
  });
}

/** 路径参数 id：非数字直接 400，绝不让 BigInt 构造函数抛裸异常变成 500。 */
export function parseIdParam(raw: unknown, label = 'id'): bigint {
  const value =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!/^\d{1,19}$/.test(value)) {
    throw new BusinessException(
      `${label} 必须是数字（收到的值：${raw === undefined ? '空' : String(raw).slice(0, 40)}）`,
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  return BigInt(value);
}

/** 可选路径/query  id → bigint | null（用于覆盖式关联表写入时的 null 语义）。 */
export function parseOptionalId(raw: unknown, label = 'id'): bigint | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  return parseIdParam(raw, label);
}

export function toIdString(id: bigint): string {
  return id.toString();
}

/** 排序字段白名单校验：未知字段报 400 而不是静默忽略（静默忽略会让前端排序"看起来没生效"）。 */
export function assertSortField(
  sortBy: string | undefined,
  allowed: readonly string[],
  fallback: string,
): string {
  if (sortBy === undefined) {
    return fallback;
  }
  if (!allowed.includes(sortBy)) {
    throw new BusinessException(
      `不支持按 "${sortBy}" 排序，可选：${allowed.join('、')}`,
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  return sortBy;
}

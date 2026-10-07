import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../config/constants';

/** 分页请求参数，见 后端接口设计.md §1.3。 */
export interface PageQueryInput {
  readonly page?: unknown;
  readonly pageSize?: unknown;
  readonly sortBy?: unknown;
  readonly sortOrder?: unknown;
}

export type SortOrder = 'asc' | 'desc';

export interface NormalizedPageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy?: string;
  readonly sortOrder?: SortOrder;
  /** 给 SQL/Prisma 用的偏移量 */
  readonly skip: number;
}

/** 分页响应体：`{ items, total }`，塞进统一信封的 `data` 里。 */
export interface PageData<TItem> {
  readonly items: readonly TItem[];
  readonly total: number;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `pageSize > 200` 夹取为 200 而不报错（§1.5）：列表页宁可少显示，也不要把请求打成 400。
 */
export function normalizePageQuery(input: PageQueryInput = {}): NormalizedPageQuery {
  const page = toPositiveInt(input.page, 1);
  const pageSize = Math.min(
    toPositiveInt(input.pageSize, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const sortOrder =
    typeof input.sortOrder === 'string' &&
    input.sortOrder.trim().toLowerCase() === 'desc'
      ? 'desc'
      : typeof input.sortOrder === 'string' &&
          input.sortOrder.trim().toLowerCase() === 'asc'
        ? 'asc'
        : undefined;
  const sortBy =
    typeof input.sortBy === 'string' && input.sortBy.trim() !== ''
      ? input.sortBy.trim()
      : undefined;

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    ...(sortBy === undefined ? {} : { sortBy }),
    ...(sortOrder === undefined ? {} : { sortOrder }),
  };
}

export function toPageData<TItem>(
  items: readonly TItem[],
  total: number,
): PageData<TItem> {
  return { items, total };
}

import type { ErrorCode } from '../constants/error-codes';

/** 统一响应体（后端接口设计 §1.2）：成功 code=0，失败 code=-1 且 HTTP 非 2xx */
export const API_OK_CODE = 0;
export const API_FAIL_CODE = -1;

export type ApiResultCode = typeof API_FAIL_CODE | typeof API_OK_CODE;

export interface ApiEnvelope<TData> {
  code: ApiResultCode;
  data: TData;
  /** 给人看的文案：vben 的错误提示取 error ?? message，所以人话必须放这里 */
  error: null | string;
  /** 稳定机器码，供前端做分支（如"查看发布报告"）与排障 */
  errorCode?: ErrorCode;
  message: string;
}

export type ApiSuccess<TData> = ApiEnvelope<TData> & {
  code: typeof API_OK_CODE;
  error: null;
};

export type ApiFailure = ApiEnvelope<null> & { code: typeof API_FAIL_CODE };

export type SortOrder = 'asc' | 'desc';

export const PAGE_DEFAULT_SIZE = 20;
export const PAGE_MAX_SIZE = 200;

export interface PageQuery {
  /** 从 1 开始 */
  page?: number;
  /** 默认 20，超过 200 服务端夹取为 200 而非报错 */
  pageSize?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
}

export interface PageResult<TItem> {
  items: TItem[];
  total: number;
}

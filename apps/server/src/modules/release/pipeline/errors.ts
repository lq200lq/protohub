import {
  ERROR_CODES,
  UPLOAD_ERROR_CODES,
  UPLOAD_ERROR_HTTP_STATUS,
  type UploadErrorCode,
  type UploadTaskErrorCode,
} from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import type { AppEnv } from '../../../config/env';

/**
 * 上传错误的唯一出口（后端接口设计 §8）。
 *
 * §8 的"人话文案"里带数字的几条（100MB / 5000 个 / 500MB / 200MB）都是 env 可调的阈值，
 * 所以文案由阈值现算而不是照抄表里的字面量：改了 `MAX_UPLOAD_BYTES` 而文案还说 100MB，
 * 用户就会照着错误的上限去准备文件（§3.7 禁止硬编码）。默认值下文案与 §8 逐字一致。
 */

export interface UploadLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxRatio: number;
  readonly maxTotalBytes: number;
  readonly maxUploadBytes: number;
}

/**
 * env → 阈值视图（机制 §2.2 的上限全部可配）。
 *
 * 只有这一处做字段映射：受理、轻校验、Worker、解压共用同一个对象，
 * 不会出现"受理按 env 判、文案按字面量写"的两套口径。
 */
export function uploadLimitsOf(upload: AppEnv['upload']): UploadLimits {
  return {
    maxEntries: upload.maxEntries,
    maxFileBytes: upload.maxFileBytes,
    maxRatio: upload.maxRatio,
    maxTotalBytes: upload.maxTotalBytes,
    maxUploadBytes: upload.maxBytes,
  };
}

/** 整 MB 显示成 `100MB`，不足 1MB 显示成 KB（阈值都是量级很大的值，不会出现小数）。 */
export function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) {
    return `${String(bytes / (1024 * 1024))}MB`;
  }
  if (bytes % 1024 === 0) {
    return `${String(bytes / 1024)}KB`;
  }
  return `${String(bytes)}B`;
}

export function uploadErrorMessage(errorCode: UploadErrorCode, limits: UploadLimits): string {
  switch (errorCode) {
    case ERROR_CODES.UPLOAD_TOO_LARGE: {
      return `文件超过 ${formatBytes(limits.maxUploadBytes)} 上限`;
    }
    case ERROR_CODES.UPLOAD_NOT_ZIP: {
      return '文件不是有效的 zip 格式';
    }
    case ERROR_CODES.UPLOAD_EMPTY: {
      return '压缩包内没有文件';
    }
    case ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES: {
      return `压缩包内文件数量超过 ${String(limits.maxEntries)} 个上限`;
    }
    case ERROR_CODES.UPLOAD_UNCOMPRESSED_TOO_LARGE: {
      return `解压后总体积超过 ${formatBytes(limits.maxTotalBytes)} 上限`;
    }
    case ERROR_CODES.UPLOAD_ENTRY_TOO_LARGE: {
      return `存在超过 ${formatBytes(limits.maxFileBytes)} 的单个文件`;
    }
    case ERROR_CODES.UPLOAD_SUSPICIOUS_RATIO: {
      return '压缩比异常，疑似压缩炸弹，已拒绝';
    }
    case ERROR_CODES.UPLOAD_UNSAFE_PATH: {
      return '压缩包内含非法路径（绝对路径或 ..）';
    }
    case ERROR_CODES.UPLOAD_SYMLINK_NOT_ALLOWED: {
      return '压缩包内含符号链接';
    }
    case ERROR_CODES.UPLOAD_MISSING_ENTRY: {
      return '未找到入口文件 index.html';
    }
    case ERROR_CODES.UPLOAD_DUPLICATE_CONTENT: {
      return '内容与当前版本一致，未产生新版本';
    }
    case ERROR_CODES.UPLOAD_WORKER_FAILED: {
      return '处理过程中出现异常，请重试';
    }
    case ERROR_CODES.UPLOAD_DISK_FULL: {
      return '存储空间不足';
    }
    default: {
      return '上传处理失败';
    }
  }
}

/**
 * 任务行失败码 → 人话（§5.3 `error.message` 的兜底文案）。
 *
 * 正常路径读不到这里：Worker 写终态时把整句话一并写进 `error_message`（机制 §8.2，界面直接读那句
 * "下一步做什么"），本函数只服务人工改坏的行与历史遗留行。既然要兜住整个码域，就不能只兜 §8 那 13 条——
 * `PROTO_NOT_FOUND` 也在任务行的取值域里（DEV-18），而它的建议操作是"重新选择目标"，不是"重试"。
 */
export function taskFailureMessageOf(
  errorCode: UploadTaskErrorCode,
  limits: UploadLimits,
): string {
  if (errorCode === ERROR_CODES.PROTO_NOT_FOUND) {
    return '原型已删除，请重新选择目标';
  }
  return uploadErrorMessage(errorCode, limits);
}

/**
 * 把一次校验失败变成接口异常（HTTP 状态按 §8 的码表）。
 *
 * `detail` 只用来附在人话后面（比如具体是哪个条目路径非法），不进 `errorCode`——
 * 前端靠 `errorCode` 映射"建议操作"，所以稳定码必须干净。
 */
export function uploadRejected(
  errorCode: UploadErrorCode,
  limits: UploadLimits,
  detail?: string,
): BusinessException {
  const base = uploadErrorMessage(errorCode, limits);
  const message = detail ? `${base}：${detail}` : base;
  return new BusinessException(message, errorCode, UPLOAD_ERROR_HTTP_STATUS[errorCode]);
}

/** 任务失败时写进 `proto_upload_task.error_message` 的同一句话（长度受 varchar(500) 约束）。 */
export function uploadErrorText(
  errorCode: UploadErrorCode,
  limits: UploadLimits,
  detail?: string,
): string {
  const base = uploadErrorMessage(errorCode, limits);
  const full = detail ? `${base}：${detail}` : base;
  return full.length > 500 ? `${full.slice(0, 497)}…` : full;
}

/** §8 的 13 个稳定码：把任意异常收敛到其中之一。 */
const UPLOAD_ERROR_CODE_MAP: ReadonlyMap<string, UploadErrorCode> = new Map(
  Object.values(UPLOAD_ERROR_CODES).map((code) => [code, code] as const),
);

/** 从异常里取出稳定码；不是上传异常时归到 `UPLOAD_WORKER_FAILED`（§8 的兜底码）。 */
export function uploadErrorCodeOf(error: unknown): UploadErrorCode {
  if (error instanceof BusinessException) {
    const known = UPLOAD_ERROR_CODE_MAP.get(error.errorCode);
    if (known !== undefined) {
      return known;
    }
  }
  if (isDiskFullError(error)) {
    return ERROR_CODES.UPLOAD_DISK_FULL;
  }
  return ERROR_CODES.UPLOAD_WORKER_FAILED;
}

/** ENOSPC / "No space left on device"：磁盘写满是运维问题，不该混进"处理异常请重试"。 */
export function isDiskFullError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return code === 'ENOSPC' || /no space left on device/i.test(message);
}

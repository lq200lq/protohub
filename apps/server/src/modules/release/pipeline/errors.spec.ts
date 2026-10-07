import { describe, expect, it } from 'vitest';

import { ERROR_CODES, UPLOAD_ERROR_CODES, type UploadErrorCode } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { fakeAppEnv } from '../../../testing/app-env.fixture';
import {
  formatBytes,
  uploadErrorCodeOf,
  uploadErrorMessage,
  uploadErrorText,
  uploadLimitsOf,
  uploadRejected,
} from './errors';

/**
 * §8 错误码表是唯一口径来源：文案里的数字来自 env 阈值，所以这里同时验
 * "默认阈值下与文档逐字一致"和"改了阈值文案跟着变"（后者是 §3.7 禁止硬编码的正向证据）。
 */

const limits = uploadLimitsOf(fakeAppEnv().env.upload);

/** 文档 §8 的"人话"列，13 条全量。 */
const DOC_MESSAGES: ReadonlyMap<UploadErrorCode, string> = new Map([
  [ERROR_CODES.UPLOAD_TOO_LARGE, '文件超过 100MB 上限'],
  [ERROR_CODES.UPLOAD_NOT_ZIP, '文件不是有效的 zip 格式'],
  [ERROR_CODES.UPLOAD_EMPTY, '压缩包内没有文件'],
  [ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES, '压缩包内文件数量超过 5000 个上限'],
  [ERROR_CODES.UPLOAD_UNCOMPRESSED_TOO_LARGE, '解压后总体积超过 500MB 上限'],
  [ERROR_CODES.UPLOAD_ENTRY_TOO_LARGE, '存在超过 200MB 的单个文件'],
  [ERROR_CODES.UPLOAD_SUSPICIOUS_RATIO, '压缩比异常，疑似压缩炸弹，已拒绝'],
  [ERROR_CODES.UPLOAD_UNSAFE_PATH, '压缩包内含非法路径（绝对路径或 ..）'],
  [ERROR_CODES.UPLOAD_SYMLINK_NOT_ALLOWED, '压缩包内含符号链接'],
  [ERROR_CODES.UPLOAD_MISSING_ENTRY, '未找到入口文件 index.html'],
  [ERROR_CODES.UPLOAD_DUPLICATE_CONTENT, '内容与当前版本一致，未产生新版本'],
  [ERROR_CODES.UPLOAD_WORKER_FAILED, '处理过程中出现异常，请重试'],
  [ERROR_CODES.UPLOAD_DISK_FULL, '存储空间不足'],
]);

/** 文档 §8 的 HTTP 列。 */
const DOC_HTTP_STATUS: ReadonlyMap<UploadErrorCode, number> = new Map([
  [ERROR_CODES.UPLOAD_TOO_LARGE, 413],
  [ERROR_CODES.UPLOAD_NOT_ZIP, 422],
  [ERROR_CODES.UPLOAD_EMPTY, 422],
  [ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES, 422],
  [ERROR_CODES.UPLOAD_UNCOMPRESSED_TOO_LARGE, 422],
  [ERROR_CODES.UPLOAD_ENTRY_TOO_LARGE, 422],
  [ERROR_CODES.UPLOAD_SUSPICIOUS_RATIO, 422],
  [ERROR_CODES.UPLOAD_UNSAFE_PATH, 422],
  [ERROR_CODES.UPLOAD_SYMLINK_NOT_ALLOWED, 422],
  [ERROR_CODES.UPLOAD_MISSING_ENTRY, 422],
  [ERROR_CODES.UPLOAD_DUPLICATE_CONTENT, 200],
  [ERROR_CODES.UPLOAD_WORKER_FAILED, 500],
  [ERROR_CODES.UPLOAD_DISK_FULL, 500],
]);

const ALL_UPLOAD_CODES: readonly UploadErrorCode[] = Object.values(UPLOAD_ERROR_CODES);

describe('§8 文案表', () => {
  it('§8 的 13 条在测试表里一条不缺', () => {
    expect(ALL_UPLOAD_CODES).toHaveLength(13);
    for (const code of ALL_UPLOAD_CODES) {
      expect(DOC_MESSAGES.has(code), `缺 ${code} 的文案断言`).toBe(true);
      expect(DOC_HTTP_STATUS.has(code), `缺 ${code} 的 HTTP 断言`).toBe(true);
    }
  });

  it('默认阈值下文案与文档逐字一致', () => {
    for (const [code, message] of DOC_MESSAGES) {
      expect(uploadErrorMessage(code, limits)).toBe(message);
    }
  });

  it('默认阈值就是文档里的那五个数', () => {
    expect(limits).toEqual({
      maxEntries: 5000,
      maxFileBytes: 200 * 1024 * 1024,
      maxRatio: 1000,
      maxTotalBytes: 500 * 1024 * 1024,
      maxUploadBytes: 100 * 1024 * 1024,
    });
  });

  it('每条都能造出对应 HTTP 状态的异常', () => {
    for (const [code, status] of DOC_HTTP_STATUS) {
      const error = uploadRejected(code, limits);
      expect(error.httpStatus, code).toBe(status);
      expect(error.errorCode).toBe(code);
    }
  });

  it('改了阈值，文案里的数字跟着变（不硬编码 100MB）', () => {
    const tuned = { ...limits, maxEntries: 1200, maxUploadBytes: 30 * 1024 * 1024 };
    expect(uploadErrorMessage(ERROR_CODES.UPLOAD_TOO_LARGE, tuned)).toBe('文件超过 30MB 上限');
    expect(uploadErrorMessage(ERROR_CODES.UPLOAD_TOO_MANY_ENTRIES, tuned)).toBe(
      '压缩包内文件数量超过 1200 个上限',
    );
  });

  it('detail 只进文案不进稳定码', () => {
    const error = uploadRejected(ERROR_CODES.UPLOAD_UNSAFE_PATH, limits, '条目 "../a"');
    expect(error.message).toBe('压缩包内含非法路径（绝对路径或 ..）：条目 "../a"');
    expect(error.errorCode).toBe(ERROR_CODES.UPLOAD_UNSAFE_PATH);
  });
});

describe('体积显示', () => {
  it.each([
    [100 * 1024 * 1024, '100MB'],
    [500 * 1024 * 1024, '500MB'],
    [2 * 1024 * 1024, '2MB'],
    [512 * 1024, '512KB'],
    [1023, '1023B'],
  ])('%i → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('任务错误文本（proto_upload_task.error_message，varchar(500)）', () => {
  it('超长 detail 截到 500 字符以内并留省略号', () => {
    const text = uploadErrorText(ERROR_CODES.UPLOAD_UNSAFE_PATH, limits, 'x'.repeat(2000));
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('…')).toBe(true);
  });

  it('无 detail 时就是那名人话', () => {
    expect(uploadErrorText(ERROR_CODES.UPLOAD_EMPTY, limits)).toBe('压缩包内没有文件');
  });
});

describe('异常收敛', () => {
  it('已知的上传异常保留自己的稳定码', () => {
    expect(
      uploadErrorCodeOf(uploadRejected(ERROR_CODES.UPLOAD_MISSING_ENTRY, limits)),
    ).toBe(ERROR_CODES.UPLOAD_MISSING_ENTRY);
  });

  it('非上传异常归到 UPLOAD_WORKER_FAILED，而不是抛出未知结构', () => {
    expect(uploadErrorCodeOf(new Error('boom'))).toBe(ERROR_CODES.UPLOAD_WORKER_FAILED);
    const notUpload = new BusinessException('参数不对', ERROR_CODES.PARAM_INVALID, 400);
    expect(uploadErrorCodeOf(notUpload)).toBe(ERROR_CODES.UPLOAD_WORKER_FAILED);
  });

  it('ENOSPC 归为 UPLOAD_DISK_FULL（运维问题不该说"请重试"）', () => {
    expect(uploadErrorCodeOf(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(
      ERROR_CODES.UPLOAD_DISK_FULL,
    );
    expect(uploadErrorCodeOf(new Error('No space left on device'))).toBe(
      ERROR_CODES.UPLOAD_DISK_FULL,
    );
  });
});

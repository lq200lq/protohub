import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  UPLOAD_ERROR_CODES,
  UPLOAD_ERROR_HTTP_STATUS,
  type UploadErrorCode,
} from '../constants/error-codes';

/** 后端接口设计 §8 的 13 条 + 各自 HTTP 语义；Record 键取 UploadErrorCode，缺一条就编译不过 */
const DOC_UPLOAD_HTTP_STATUS: Record<UploadErrorCode, 200 | 413 | 422 | 500> = {
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_NOT_ZIP: 422,
  UPLOAD_EMPTY: 422,
  UPLOAD_TOO_MANY_ENTRIES: 422,
  UPLOAD_UNCOMPRESSED_TOO_LARGE: 422,
  UPLOAD_ENTRY_TOO_LARGE: 422,
  UPLOAD_SUSPICIOUS_RATIO: 422,
  UPLOAD_UNSAFE_PATH: 422,
  UPLOAD_SYMLINK_NOT_ALLOWED: 422,
  UPLOAD_MISSING_ENTRY: 422,
  UPLOAD_DUPLICATE_CONTENT: 200,
  UPLOAD_WORKER_FAILED: 500,
  UPLOAD_DISK_FULL: 500,
};

describe('UPLOAD_* 错误码', () => {
  it('§8 的 13 条全量在册', () => {
    expect(Object.values(UPLOAD_ERROR_CODES).toSorted()).toEqual(
      Object.keys(DOC_UPLOAD_HTTP_STATUS).toSorted(),
    );
    expect(Object.keys(UPLOAD_ERROR_CODES)).toHaveLength(13);
  });

  it('HTTP 状态与 §8 表格逐条一致', () => {
    for (const [code, status] of Object.entries(DOC_UPLOAD_HTTP_STATUS)) {
      expect(UPLOAD_ERROR_HTTP_STATUS[code as UploadErrorCode]).toBe(status);
    }
  });
});

describe('ERROR_CODES', () => {
  it('无重复取值', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('键与取值同名，展开合并不会互相覆盖', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(key).toBe(value);
      expect(value).toMatch(/^[A-Z][A-Z\d]*(_[A-Z\d]+)+$/);
    }
  });

  it.each([
    'AUTH_BAD_CREDENTIALS',
    'AUTH_DISABLED',
    'AUTH_REFRESH_INVALID',
    'AUTH_FORBIDDEN',
    'INTERNAL_ERROR',
    'RATE_LIMITED',
    'PROTO_SLUG_DUPLICATED',
    'PROTO_CODE_IMMUTABLE',
    'PROTO_NOT_ACCESSIBLE',
    'PROTO_ARCHIVED',
    'PROJECT_ARCHIVED',
    'PROTO_POLICY_PASSWORD_REQUIRED',
    'RELEASE_IS_CURRENT',
    'ROLE_IN_USE',
    'MENU_HAS_CHILDREN',
    'ACCESS_BAD_PASSWORD',
    'PROTO_NOT_FOUND',
    'UPLOAD_TASK_NOT_FOUND',
  ])('覆盖文档点名的错误码 %s', (code) => {
    expect(Object.values(ERROR_CODES)).toContain(code);
  });
});

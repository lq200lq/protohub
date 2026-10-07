import { HttpStatus } from '@nestjs/common';

/**
 * 业务异常。三个字段的分工见 后端接口设计.md §1.2 / §1.4：
 * - `message`   → 给人看的话，进响应体的 `error` 与 `message`
 * - `errorCode` → 机器码（`AUTH_*`、`*_NOT_FOUND`、`UPLOAD_*`…），只进 `errorCode`
 * - `httpStatus`→ 语义见下两个子类的注释，别写反
 */
export class BusinessException extends Error {
  readonly errorCode: string;
  readonly httpStatus: number;

  constructor(
    message: string,
    errorCode: string,
    httpStatus: number = HttpStatus.BAD_REQUEST,
  ) {
    super(message);
    this.name = 'BusinessException';
    this.errorCode = errorCode;
    this.httpStatus = httpStatus;
  }
}

/**
 * 401 严格只表示"未登录 / accessToken 无效、过期、被撤销"。
 * vben 只对 401 触发令牌刷新，拿 401 表示"没权限"会把用户反复踢去登录页。
 */
export class UnauthorizedException extends BusinessException {
  constructor(
    message = '登录状态已失效，请重新登录',
    errorCode = 'AUTH_TOKEN_INVALID',
  ) {
    super(message, errorCode, HttpStatus.UNAUTHORIZED);
    this.name = 'UnauthorizedException';
  }
}

/**
 * 403 严格只表示"已登录但权限不足 / 超出数据范围"。
 * 它绝不能被前端理解成"该刷新令牌了"，否则会变成无限刷新循环。
 */
export class ForbiddenBusinessException extends BusinessException {
  constructor(
    message = '没有权限执行该操作',
    errorCode = 'AUTH_FORBIDDEN',
  ) {
    super(message, errorCode, HttpStatus.FORBIDDEN);
    this.name = 'ForbiddenBusinessException';
  }
}

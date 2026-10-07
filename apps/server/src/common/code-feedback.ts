import {
  ERROR_CODES,
  validateProjectCode,
  validatePrototypeCode,
  type CodeInvalidReason,
} from '@protohub/shared';

import { CODE_AUTOGEN_MAX_RETRY } from '../config/constants';
import { BusinessException } from './exception/business.exception';

/**
 * 编码判定的人话出口（决策 D-20 + 后端接口设计 §4.2/§4.3.3）。
 *
 * 为什么单独一个文件：同一条规则有**三个**入口要说这句话——新建项目、新建原型、
 * 上传发布时顺带新建（接口设计 §5.1 的三合一）。话术抄三遍必然漂移（§3.7 通用能力收敛一处），
 * 而"编码已被占用"说得不一致会直接影响用户换码的决策。
 *
 * 项目与原型的话术刻意保留差异：项目码全库唯一且要查保留字（§4.2），
 * 原型码只在项目内唯一、且带上父项目编码才定位得准（§4.3.3）。
 */

/** §4.2 的 check-code 也复用这句（那里返回的是文案而不是异常）。 */
export function projectCodeMessage(value: string, reason: CodeInvalidReason | null): string {
  if (reason === 'RESERVED') {
    return `"${value}" 是平台保留字，不能用作项目编码`;
  }
  if (reason === 'TOO_LONG') {
    return '项目编码最长 63 个字符';
  }
  if (reason === 'EMPTY') {
    return '项目编码不能为空';
  }
  return '项目编码只能用小写字母、数字和短横线，且不能以短横线开头或结尾（形如 crm、crm-2）';
}

/** 原型码不查保留字（`validatePrototypeCode` 的语义），所以这里只有格式与超长两类。 */
export function prototypeCodeMessage(code: string, reason: CodeInvalidReason | null): string {
  if (reason === 'TOO_LONG') {
    return '原型编码最长 63 个字符';
  }
  if (reason === 'EMPTY') {
    return '原型编码不能为空';
  }
  return `原型编码「${code}」格式不合法：只能用小写字母、数字和短横线，且不能以短横线开头或结尾（形如 login-flow）`;
}

/** 手填项目码的格式判定（§4.2）：不合法直接 400，占用与否由调用方查库后再判。 */
export function assertProjectCodeFormat(code: string): void {
  const format = validateProjectCode(code);
  if (!format.valid) {
    throw new BusinessException(
      projectCodeMessage(code, format.reason),
      ERROR_CODES.PROTO_CODE_INVALID,
      400,
    );
  }
}

/** 手填原型码的格式判定（§4.3.3）。 */
export function assertPrototypeCodeFormat(code: string): void {
  const format = validatePrototypeCode(code);
  if (!format.valid) {
    throw new BusinessException(
      prototypeCodeMessage(code, format.reason),
      ERROR_CODES.PROTO_CODE_INVALID,
      400,
    );
  }
}

/** 查库确认已被占用：把占用者名字带出来，用户才知道该换而不是该重试。 */
export function projectCodeTakenError(occupantName: string): BusinessException {
  return new BusinessException(
    `编码已被项目「${occupantName}」占用，请换一个`,
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    400,
  );
}

export function prototypeCodeTakenError(
  projectCode: string,
  code: string,
  occupantName: string,
): BusinessException {
  return new BusinessException(
    `编码「${code}」已被项目「${projectCode}」下的原型「${occupantName}」占用，请换一个`,
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    400,
  );
}

/** 预查通过但 INSERT 撞了唯一索引：说明是并发抢码，409（§1.4 的 409 语义）。 */
export function projectCodeRaceError(): BusinessException {
  return new BusinessException(
    '该编码刚被其他项目占用，请重新检查',
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    409,
  );
}

export function prototypeCodeRaceError(): BusinessException {
  return new BusinessException(
    '该编码刚被同项目的其他原型占用，请重新检查',
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    409,
  );
}

/** 自动生成码连续冲突到上限（CODE_AUTOGEN_MAX_RETRY）：把"为什么不再试了"说清楚。 */
export function projectCodeExhaustedError(): BusinessException {
  return new BusinessException(
    `自动生成项目编码连续 ${String(CODE_AUTOGEN_MAX_RETRY)} 次冲突，请稍后重试`,
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    409,
  );
}

export function prototypeCodeExhaustedError(): BusinessException {
  return new BusinessException(
    `自动生成原型编码连续 ${String(CODE_AUTOGEN_MAX_RETRY)} 次冲突，请稍后重试`,
    ERROR_CODES.PROTO_SLUG_DUPLICATED,
    409,
  );
}

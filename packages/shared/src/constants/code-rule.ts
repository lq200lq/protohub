import { isReservedCode } from './reserved-codes';

/** 编码格式（决策 D-20）：前后端共用这一份，DB CHECK 只做兜底 */
export const CODE_RULE = {
  pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  maxLength: 63,
} as const;

export const PROJECT_CODE_PREFIX = 'p-';
export const PROJECT_CODE_RANDOM_LENGTH = 8;
export const PROTOTYPE_CODE_SEQ_PREFIX = '-p';

/**
 * 输入即规范化：只留 `CODE_RULE.pattern` 认的字符（小写字母、数字、连字符），其余不落输入。
 *
 * 与 `CODE_RULE` 放在一起，是为了让"输入框允许什么"和"服务端认为什么合法"永远是同一份答案——
 * 界面自己过滤一套、服务端再拒一套，用户就只能靠试错猜规则（前端设计 §3.4）。
 */
export function normalizeCodeInput(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

const BASE36_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE36_RADIX = 36;
const UINT32_RANGE = 2 ** 32;

export type RandomSource = () => number;

interface GetRandomValuesCapable {
  getRandomValues?: (buffer: Uint32Array) => Uint32Array;
}

/** 优先用 CSPRNG：项目码是随机分配的，Math.random 的可预测性会让并发抢码变成可被猜中的冲突 */
function webCryptoRandom(): null | RandomSource {
  const cryptoObject = (globalThis as { crypto?: GetRandomValuesCapable }).crypto;
  const getRandomValues = cryptoObject?.getRandomValues?.bind(cryptoObject);
  if (!getRandomValues) {
    return null;
  }
  const buffer = new Uint32Array(1);
  return () => {
    const words = getRandomValues(buffer);
    return (words[0] ?? 0) / UINT32_RANGE;
  };
}

export function randomBase36(length: number, random?: RandomSource): string {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError('length must be a positive integer');
  }
  const source = random ?? webCryptoRandom() ?? Math.random;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    const alphabetIndex = Math.floor(source() * BASE36_RADIX);
    output += BASE36_ALPHABET[alphabetIndex] ?? '0';
  }
  return output;
}

export function genProjectCode(random?: RandomSource): string {
  return `${PROJECT_CODE_PREFIX}${randomBase36(PROJECT_CODE_RANDOM_LENGTH, random)}`;
}

/** 序号超过 99 时自然进位成 p100（padStart 只补齐、不截断） */
export function genPrototypeCode(projectCode: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError('seq must be a positive integer');
  }
  return `${projectCode}${PROTOTYPE_CODE_SEQ_PREFIX}${String(seq).padStart(2, '0')}`;
}

export type CodeInvalidReason = 'EMPTY' | 'FORMAT_INVALID' | 'RESERVED' | 'TOO_LONG';

export interface CodeValidationResult {
  reason: CodeInvalidReason | null;
  valid: boolean;
}

const VALID_CODE: CodeValidationResult = { valid: true, reason: null };

function invalid(reason: CodeInvalidReason): CodeValidationResult {
  return { valid: false, reason };
}

/** 留空是合法的（交由服务端生成），所以"空"在这里返回 INVALID/EMPTY，由调用方决定它是生成信号 */
export function validateCode(code: string): CodeValidationResult {
  if (code.length === 0) {
    return invalid('EMPTY');
  }
  if (code.length > CODE_RULE.maxLength) {
    return invalid('TOO_LONG');
  }
  if (!CODE_RULE.pattern.test(code)) {
    return invalid('FORMAT_INVALID');
  }
  return VALID_CODE;
}

export function validateProjectCode(code: string): CodeValidationResult {
  const format = validateCode(code);
  if (!format.valid) {
    return format;
  }
  return isReservedCode(code) ? invalid('RESERVED') : VALID_CODE;
}

/** 原型码挂在 /p/{项目码}/ 之下，不与平台一级路由冲突，因此不查保留字 */
export function validatePrototypeCode(code: string): CodeValidationResult {
  return validateCode(code);
}

export function isValidCode(code: string): boolean {
  return validateCode(code).valid;
}

export function isValidProjectCode(code: string): boolean {
  return validateProjectCode(code).valid;
}

export function isValidPrototypeCode(code: string): boolean {
  return validatePrototypeCode(code).valid;
}

/** 只认「项目码 + 序号」这一种生成形态；用户手填的原型码不参与取号 */
export function parseGeneratedPrototypeCode(
  projectCode: string,
  code: string,
): null | number {
  const prefix = `${projectCode}${PROTOTYPE_CODE_SEQ_PREFIX}`;
  if (!code.startsWith(prefix)) {
    return null;
  }
  const digits = code.slice(prefix.length);
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

export function nextGeneratedPrototypeCode(
  projectCode: string,
  existingCodes: readonly string[],
): string {
  let maxSeq = 0;
  for (const code of existingCodes) {
    const seq = parseGeneratedPrototypeCode(projectCode, code);
    if (seq !== null && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  return genPrototypeCode(projectCode, maxSeq + 1);
}

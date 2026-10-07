import { randomInt } from 'node:crypto';

/**
 * 口令策略（权限模型设计 §3.6 的 resetpwd / 后端接口设计 §2.8 的强度规则）。
 *
 * §2.8 原文："新密码 ≥8 位且含大小写/数字/符号中至少 3 类"。
 * 这里把它写成**纯函数**而不是散在各 service 里的 if：M1-T15 明确要求"密码强度"有单测，
 * 而 create 用户（生成初始密码）与 change/reset 密码（校验人工输入）三个入口必须共用同一套判定，
 * 否则会出现"管理员生成的密码通不过用户自己改密的校验"这种荒唐结果。
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;
/** "大小写/数字/符号中至少 3 类"——四类里的 3 类。 */
export const REQUIRED_CHAR_CLASSES = 3;

const LOWERCASE = /[a-z]/;
const UPPERCASE = /[A-Z]/;
const DIGIT = /[0-9]/;
/** 符号 = 非字母数字的非空白可见字符（避免把空格/中文当符号）。 */
const SYMBOL = /[^A-Za-z0-9\s]/;

export interface PasswordCheckResult {
  readonly valid: boolean;
  /** 不通过时给前端展示的人话原因 */
  readonly reason: string | null;
  /** 命中的字符类别数，便于测试断言 */
  readonly classCount: number;
}

export function countCharClasses(value: string): number {
  return [LOWERCASE, UPPERCASE, DIGIT, SYMBOL].filter((pattern) =>
    pattern.test(value),
  ).length;
}

export function checkPasswordStrength(input: string): PasswordCheckResult {
  const value = input ?? '';
  if (value.length < PASSWORD_MIN_LENGTH) {
    return fail(`密码至少 ${PASSWORD_MIN_LENGTH} 位`, 0);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return fail(`密码最多 ${PASSWORD_MAX_LENGTH} 位`, 0);
  }
  if (/\s/.test(value)) {
    return fail('密码不能包含空格或制表符', countCharClasses(value));
  }
  const classCount = countCharClasses(value);
  if (classCount < REQUIRED_CHAR_CLASSES) {
    return fail(
      `密码需包含大写字母、小写字母、数字、符号中的至少 ${REQUIRED_CHAR_CLASSES} 类`,
      classCount,
    );
  }
  return { valid: true, reason: null, classCount };
}

function fail(reason: string, classCount: number): PasswordCheckResult {
  return { valid: false, reason, classCount };
}

/**
 * 随机初始密码（后端接口设计 §7.1.2/§7.1.6：服务端生成、只返回一次）。
 * 从四类字符各取至少一个再打乱，保证一定满足上面的强度判定；
 * 排除易混淆字符（0/O、1/l/I）——管理员要手抄给用户，抄错的代价是"登录不上且没人知道为什么"。
 * 用 crypto.randomInt（不是 Math.random）：这是凭据生成，必须是 CSPRNG。
 */
const GENERATOR_ALPHABETS: readonly string[] = [
  'abcdefghijkmnopqrstuvwxyz',
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  '23456789',
  '!@#$%^&*-_+=?',
];

export function generateInitialPassword(length = 12): string {
  const total = Math.max(length, GENERATOR_ALPHABETS.length + 2);
  const characters: string[] = GENERATOR_ALPHABETS.map((alphabet) =>
    pickFrom(alphabet),
  );
  const allAlphabets = GENERATOR_ALPHABETS.join('');
  while (characters.length < total) {
    characters.push(pickFrom(allAlphabets));
  }
  return shuffle(characters).join('');
}

function pickFrom(alphabet: string): string {
  return alphabet.charAt(randomInt(0, alphabet.length));
}

/** Fisher-Yates；原地打乱足够，不需要额外拷贝。 */
function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = randomInt(0, index + 1);
    const current = items[index] as T;
    items[index] = items[target] as T;
    items[target] = current;
  }
  return items;
}

/**
 * 密码强度规则（后端接口设计 §2.8）：
 * ≥8 位，且包含 大写/小写/数字/符号 至少 3 类。
 * 这里是纯函数，供表单校验与单测共用；一期不做历史密码比对。
 */
const CLASS_TESTERS: Array<(value: string) => boolean> = [
  (value) => /[a-z]/.test(value),
  (value) => /[A-Z]/.test(value),
  (value) => /\d/.test(value),
  (value) => /[^A-Za-z0-9]/.test(value),
];

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MIN_CLASSES = 3;

export function passwordCharClasses(value: string): number {
  return CLASS_TESTERS.filter((test) => test(value)).length;
}

export function validatePasswordStrength(value: string): boolean {
  return (
    value.length >= PASSWORD_MIN_LENGTH &&
    passwordCharClasses(value) >= PASSWORD_MIN_CLASSES
  );
}

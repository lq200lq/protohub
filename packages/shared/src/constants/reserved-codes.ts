/** 保留字同时是路由第一段候选，占用会和 /api、/p 等平台路径冲突（后端接口设计 §4.2） */
export const RESERVED_CODES = [
  'api',
  'admin',
  'static',
  'assets',
  'p',
  'login',
  'health',
  'system',
  'proto',
  'www',
] as const;

export type ReservedCode = (typeof RESERVED_CODES)[number];

const RESERVED_CODE_SET: ReadonlySet<string> = new Set<string>(RESERVED_CODES);

export function isReservedCode(code: string): boolean {
  return RESERVED_CODE_SET.has(code);
}

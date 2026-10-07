/**
 * 首管密码：随机生成 + argon2id 哈希（数据库设计 §4.1.1 注 password_hash = argon2id）。
 *
 * apps/server 的 auth 模块在 M1-T5 才落地哈希实现；本文件按 argon2 默认参数产出
 * argon2id（64MiB/3 iter/parallelism 1），M1 后端 verify 必须用同库同默认参数，
 * 否则首管登录会失败。这一点要写进 M1-T5 的验收。
 */
import { randomInt } from 'node:crypto';
import argon2 from 'argon2';

// 去掉了易混淆字符（0/O、1/l/I），符号集限制在 shell 安全字符里，避免复制粘贴转义问题
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;
const PASSWORD_LENGTH = 16;

function pick(charset: string): string {
  return charset[randomInt(charset.length)] as string;
}

/** 16 位随机密码，四类字符各至少一个（randomInt 走 CSPRNG，不用 Math.random）。 */
export function generateInitialPassword(): string {
  const guaranteed = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const rest = Array.from({ length: PASSWORD_LENGTH - guaranteed.length }, () => pick(ALL));
  // Fisher-Yates 洗牌，避免"前四位固定类别"削弱随机性
  const chars = [...guaranteed, ...rest];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join('');
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain); // 默认即 argon2id
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return argon2.verify(hashed, plain);
}

import { describe, expect, it } from 'vitest';

import {
  CODE_RULE,
  genProjectCode,
  genPrototypeCode,
  isValidCode,
  isValidProjectCode,
  isValidPrototypeCode,
  nextGeneratedPrototypeCode,
  parseGeneratedPrototypeCode,
  randomBase36,
  validateCode,
  validateProjectCode,
  validatePrototypeCode,
} from '../constants/code-rule';
import { isReservedCode, RESERVED_CODES } from '../constants/reserved-codes';

function seededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

interface CryptoLike {
  getRandomValues: (buffer: Uint32Array) => Uint32Array;
}

function withCrypto(cryptoValue: CryptoLike | undefined, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: cryptoValue,
  });
  try {
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'crypto');
    }
  }
}

describe('CODE_RULE 格式校验', () => {
  const accepted = [
    'crm',
    'a',
    'z09',
    'crm-2',
    'login-page',
    'p-7f3k9m2x',
    'crm-p01',
    'a-b-c-1-2-3',
    '0',
    '0-0',
  ];

  const rejected = [
    'Crm',
    'CRM',
    'crm_2',
    'crm.2',
    '-crm',
    'crm-',
    'crm--2',
    'crm 2',
    '/crm',
    'crm/',
    'cr m',
    'crm-2!',
    '中文',
    'crm-2#',
  ];

  it.each(accepted)('接受 %s', (code) => {
    expect(isValidCode(code)).toBe(true);
    expect(CODE_RULE.pattern.test(code)).toBe(true);
  });

  it.each(rejected)('拒绝 %s', (code) => {
    expect(isValidCode(code)).toBe(false);
    expect(validateCode(code).reason).toBe('FORMAT_INVALID');
  });

  it('长度边界：63 通过、64 拒绝、空串单独成类', () => {
    const atLimit = `a${'-b'.repeat(31)}`;
    expect(atLimit.length).toBe(63);
    expect(validateCode(atLimit)).toEqual({ valid: true, reason: null });
    expect(validateCode(`${atLimit}c`).reason).toBe('TOO_LONG');
    expect(validateCode('').reason).toBe('EMPTY');
    expect(isValidCode('')).toBe(false);
  });
});

describe('保留字', () => {
  it('清单与后端接口设计 §4.2 一致', () => {
    expect([...RESERVED_CODES]).toEqual([
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
    ]);
  });

  it.each([...RESERVED_CODES])('项目码 %s 被拒', (code) => {
    expect(isReservedCode(code)).toBe(true);
    expect(isValidProjectCode(code)).toBe(false);
    expect(validateProjectCode(code).reason).toBe('RESERVED');
  });

  it('带后缀的同形词可用，原型码不查保留字', () => {
    expect(isValidProjectCode('api-2')).toBe(true);
    expect(isReservedCode('API')).toBe(false);
    expect(validatePrototypeCode('api')).toEqual({ valid: true, reason: null });
  });
});

describe('genProjectCode', () => {
  it('形如 p- + 8 位 base36 且满足编码规则', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = genProjectCode(seededRandom(index + 1));
      expect(code).toMatch(/^p-[0-9a-z]{8}$/);
      expect(isValidProjectCode(code)).toBe(true);
    }
  });

  it('随机源可注入：同一序列确定性，不同序列不同码', () => {
    expect(genProjectCode(seededRandom(1))).toBe(genProjectCode(seededRandom(1)));
    expect(genProjectCode(seededRandom(1))).not.toBe(genProjectCode(seededRandom(2)));
    expect(randomBase36(8, () => 0)).toBe('00000000');
    expect(randomBase36(8, () => 0.999_999_999_9)).toBe('zzzzzzzz');
  });

  it('大批量生成不撞码', () => {
    const codes = new Set<string>();
    for (let index = 0; index < 5000; index += 1) {
      codes.add(genProjectCode());
    }
    expect(codes.size).toBe(5000);
  });

  it('默认走 CSPRNG 而不是 Math.random', () => {
    let calls = 0;
    withCrypto(
      {
        getRandomValues: (buffer: Uint32Array) => {
          calls += 1;
          buffer.fill(3);
          return buffer;
        },
      },
      () => {
        expect(genProjectCode()).toBe('p-00000000');
        expect(calls).toBe(8);
      },
    );
  });

  it('无 CSPRNG 时退回 Math.random 仍产出合法码', () => {
    withCrypto(undefined, () => {
      expect(genProjectCode()).toMatch(/^p-[0-9a-z]{8}$/);
    });
  });

  it('randomBase36 拒绝非正整数长度', () => {
    expect(() => randomBase36(0)).toThrow(RangeError);
    expect(() => randomBase36(1.5)).toThrow(RangeError);
  });
});

describe('genPrototypeCode', () => {
  it('序号两位起，跨过 p99 自然进三位', () => {
    expect(genPrototypeCode('crm', 1)).toBe('crm-p01');
    expect(genPrototypeCode('crm', 9)).toBe('crm-p09');
    expect(genPrototypeCode('crm', 10)).toBe('crm-p10');
    expect(genPrototypeCode('crm', 99)).toBe('crm-p99');
    expect(genPrototypeCode('crm', 100)).toBe('crm-p100');
    expect(genPrototypeCode('crm', 1000)).toBe('crm-p1000');
  });

  it('序号不截断且始终合法', () => {
    for (const seq of [1, 42, 99, 100, 9999]) {
      expect(isValidPrototypeCode(genPrototypeCode('crm', seq))).toBe(true);
    }
  });

  it('自动生成的项目码也能拼出合法原型码', () => {
    const projectCode = genProjectCode();
    expect(genPrototypeCode(projectCode, 3)).toBe(`${projectCode}-p03`);
    expect(isValidPrototypeCode(genPrototypeCode(projectCode, 3))).toBe(true);
  });

  it('拒绝非正整数序号', () => {
    expect(() => genPrototypeCode('crm', 0)).toThrow(RangeError);
    expect(() => genPrototypeCode('crm', -1)).toThrow(RangeError);
    expect(() => genPrototypeCode('crm', 2.5)).toThrow(RangeError);
    expect(() => genPrototypeCode('crm', Number.NaN)).toThrow(RangeError);
  });
});

describe('取号与解析', () => {
  it('解析生成形态的序号，忽略手填码', () => {
    expect(parseGeneratedPrototypeCode('crm', 'crm-p07')).toBe(7);
    expect(parseGeneratedPrototypeCode('crm', 'crm-p100')).toBe(100);
    expect(parseGeneratedPrototypeCode('crm', 'crm-login')).toBeNull();
    expect(parseGeneratedPrototypeCode('crm', 'crm-p')).toBeNull();
    expect(parseGeneratedPrototypeCode('crm-2', 'crm-p01')).toBeNull();
  });

  it('按现有码取下一个序号，含 p99→p100', () => {
    expect(nextGeneratedPrototypeCode('crm', [])).toBe('crm-p01');
    expect(nextGeneratedPrototypeCode('crm', ['crm-p01', 'crm-p02'])).toBe('crm-p03');
    expect(
      nextGeneratedPrototypeCode('crm', ['crm-p01', 'crm-p09', 'crm-p10', 'crm-p99']),
    ).toBe('crm-p100');
    expect(nextGeneratedPrototypeCode('crm', ['crm-p100', 'crm-login'])).toBe('crm-p101');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessLogRow } from './access-log.repo';
import { AccessLogRecorderService, type AccessVisit } from './access-log.recorder.service';

/**
 * 录入口（机制 §6；迭代实施计划 M4-T9）。
 *
 * 只桩缓冲层：这里要验的是"一次判定换成一行"的映射，写库时机在 `access-log.buffer.service.spec.ts`。
 * 请求用真的头部对象形状（`{ headers, ip }`），因为 IP/UA 的取值顺序本身就是被测行为。
 */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** 桌面上最常见的那条 UA：`Chrome` 这种裸字符串是解析不出版本的，测试要用真形状。 */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

interface BufferDouble {
  enqueue: ReturnType<typeof vi.fn>;
  rows: () => AccessLogRow[];
  service: AccessLogRecorderService;
}

function bufferDouble(): BufferDouble {
  const rows: AccessLogRow[] = [];
  const enqueue = vi.fn((row: AccessLogRow) => {
    rows.push(row);
  });
  const service = new AccessLogRecorderService({
    enqueue,
  } as unknown as ConstructorParameters<typeof AccessLogRecorderService>[0]);
  return { enqueue, rows: () => [...rows], service };
}

function request(
  overrides: {
    readonly headers?: Record<string, unknown>;
    readonly ip?: string;
  } = {},
): AccessVisit['request'] {
  return {
    headers: { 'user-agent': CHROME_UA, 'x-real-ip': '116.226.1.7', ...overrides.headers },
    ip: overrides.ip ?? '127.0.0.1',
  };
}

function visit(overrides: Partial<AccessVisit> = {}): AccessVisit {
  return {
    isEntry: true,
    projectCode: 'crm',
    prototypeCode: 'crm-p01',
    request: request(),
    status: 200,
    uri: '/p/crm/crm-p01/',
    ...overrides,
  };
}

const FULL = {
  browser: 'Chrome 141',
  device: 'desktop',
  ip: '116.226.1.7',
  isBot: false,
  os: 'Windows 10/11',
  path: '/p/crm/crm-p01/',
  prototypeId: 31n,
  referer: null,
  releaseId: 77n,
  result: 'ok',
  routeKey: 'crm/crm-p01',
  ua: CHROME_UA,
  userId: null,
} as const;

function rowOf(buffer: BufferDouble, index = 0): AccessLogRow {
  const row = buffer.rows()[index];
  if (row === undefined) {
    throw new Error('缓冲里一行都没有');
  }
  return row;
}

beforeEach(() => {
  // "请求时刻"那条要用 fake timers 钉住时钟，不能受上一个用例残留的时钟影响
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('一次判定 → 一行', () => {
  it('入口 200：结论里的三个 id、路由键、IP 与 UA 派生列一并落进行', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ prototypeId: '31', releaseId: '77' }));

    expect(buffer.enqueue).toHaveBeenCalledOnce();
    expect(rowOf(buffer)).toMatchObject(FULL);
  });

  it('member 档的登录用户进 user_id（§6.1 的 visitorName 只有这一路来源）', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ userId: '42' }));

    expect(rowOf(buffer).userId).toBe(42n);
  });

  it('请求时刻就是行上的时刻，不是写入时刻', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T16:00:00.000Z'));
    const buffer = bufferDouble();

    buffer.service.record(visit());

    expect(rowOf(buffer).createdAt).toEqual(new Date('2026-10-06T16:00:00.000Z'));
  });

  it('UA 是真的解析出来的，不是原样塞进四个列', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ request: request({ headers: { 'user-agent': IPHONE_UA } }) }));

    const row = rowOf(buffer);
    expect(row.ua).toBe(IPHONE_UA);
    expect(row).toMatchObject({ browser: 'Safari 17', device: 'mobile', os: 'iOS 17.5.1' });
  });

  it('referer 只在带了的时候才有值', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit());
    buffer.service.record(visit({ request: request({ headers: { referer: 'https://im.corp/x' } }) }));

    expect(buffer.rows()[0]?.referer).toBeNull();
    expect(buffer.rows()[1]?.referer).toBe('https://im.corp/x');
  });
});

describe('记不记不在这层重写一遍（口径见 record-policy）', () => {
  it('M4-T9 的验收标准：20 次资源 + 1 次入口 → 缓冲里只有 1 行', () => {
    const buffer = bufferDouble();

    for (let i = 0; i < 20; i += 1) {
      buffer.service.record(
        visit({
          isEntry: false,
          status: 200,
          uri: `/p/crm/crm-p01/assets/f${String(i)}.js`,
        }),
      );
    }
    buffer.service.record(visit());

    expect(buffer.rows()).toHaveLength(1);
    expect(rowOf(buffer).path).toBe('/p/crm/crm-p01/');
  });

  it.each([
    ['301 补尾斜杠', 301],
    ['304 命中缓存', 304],
    ['500 读盘故障', 500],
  ] as const)('%s 不进缓冲', (_label, status) => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ status }));

    expect(buffer.enqueue).not.toHaveBeenCalled();
  });

  it('编码为空就没有可归属的 route_key（这列 NOT NULL），这种请求不记', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ projectCode: '' }));
    buffer.service.record(visit({ prototypeCode: '' }));

    expect(buffer.enqueue).not.toHaveBeenCalled();
  });

  it('被拒的资源请求照记：denied_401 那一档统计的就是"有人在试哪些链接"', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({ isEntry: false, status: 401, uri: '/p/crm/crm-p01/assets/app.js' }),
    );

    expect(rowOf(buffer)).toMatchObject({
      path: '/p/crm/crm-p01/assets/app.js',
      result: 'denied_401',
    });
  });
});

describe('入库形状必须服从列宽与列类型（数据库设计 §4.2.7）', () => {
  it('查询串与片段不进 path：链接里可能带临时口令', () => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ uri: '/p/crm/crm-p01/?token=abc#sect' }));

    expect(rowOf(buffer).path).toBe('/p/crm/crm-p01/');
  });

  it('超长的一律裁到列宽，不让一次写入失败', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({
        projectCode: 'p'.repeat(80),
        prototypeCode: 'q'.repeat(80),
        request: request({
          headers: { referer: 'https://r/'.padEnd(600, 'x'), 'user-agent': 'u'.repeat(900) },
        }),
        uri: `/p/a/b/${'d'.repeat(600)}.js`,
      }),
    );

    const row = rowOf(buffer);
    expect(row.ua).toHaveLength(500);
    expect(row.path).toHaveLength(500);
    expect(row.referer).toHaveLength(500);
    // route_key 两半各 80 加一个斜杠 = 161，裁到 140
    expect(row.routeKey).toHaveLength(140);
  });

  it.each([
    ['非数字 id', 'not-a-bigint'],
    ['带符号的 id', '-7'],
    ['空串', ''],
  ] as const)('%s 当没有：塞进 bigint 列会让整批插入失败', (_label, value) => {
    const buffer = bufferDouble();

    buffer.service.record(visit({ prototypeId: value, releaseId: value }));

    const row = rowOf(buffer);
    expect(row.prototypeId).toBeNull();
    expect(row.releaseId).toBeNull();
  });

  it('没有 id（编码不存在那一档）时留空，靠 route_key 归属', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({
        prototypeCode: 'crm-pzz',
        prototypeId: null,
        releaseId: null,
        status: 404,
        uri: '/p/crm/crm-pzz/',
      }),
    );

    expect(rowOf(buffer)).toMatchObject({
      path: '/p/crm/crm-pzz/',
      prototypeId: null,
      releaseId: null,
      result: 'not_found',
      routeKey: 'crm/crm-pzz',
    });
  });
});

describe('IP 取值顺序（机制 §6：XFF 可伪造，以 nginx 写的 X-Real-IP 为准）', () => {
  it('X-Real-IP 优先于 XFF 与 socket', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({
        request: {
          headers: {
            'user-agent': 'Chrome',
            'x-forwarded-for': '8.8.8.8',
            'x-real-ip': '116.226.1.7',
          },
          ip: '10.0.0.9',
        },
      }),
    );

    expect(rowOf(buffer).ip).toBe('116.226.1.7');
  });

  it('直连（开发环境）没有那些头时回落 socket 地址', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({ request: { headers: { 'user-agent': 'Chrome' }, ip: '127.0.0.1' } }),
    );

    expect(rowOf(buffer).ip).toBe('127.0.0.1');
  });

  it('拿不到合法 IP 就存 null，不给 inet 列塞脏值', () => {
    const buffer = bufferDouble();

    buffer.service.record(
      visit({ request: { headers: { 'user-agent': 'Chrome', 'x-real-ip': 'unknown' } } }),
    );

    expect(rowOf(buffer).ip).toBeNull();
  });
});

it('缓冲层出问题也吞掉：记录是副作用，不能把打开原型这件事拖下水（F-17）', () => {
  const enqueue = vi.fn(() => {
    throw new Error('buffer exploded');
  });
  const service = new AccessLogRecorderService({
    enqueue,
  } as unknown as ConstructorParameters<typeof AccessLogRecorderService>[0]);

  expect(() => {
    service.record(visit());
  }).not.toThrow();
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { fakeAppEnv } from '../../testing/app-env.fixture';
import type { AccessVisit } from '../accesslog/access-log.recorder.service';
import type { StaticRequest, StaticResponse } from './prototype-static.service';
import { PrototypeStaticRoute } from './prototype-static.route';

/**
 * 直出路由的**传输层**（迭代实施计划 M4-T4）。判定在 `prototype-static.service.spec.ts` 里验，
 * 这里只验"把结论变成一次 HTTP 响应"这一段——它短到看起来不值得单测，偏偏是只有实测才会发现
 * 问题的地方（下面 `handler 同步返回 undefined` 那条就是 curl 实测踩出来的）。
 *
 * 只桩 `PrototypeStaticService.serve` 与 Fastify 实例；`createReadStream`、状态码、响应头
 * 都是真的代码路径。
 */

/** 真的存在的小文件：`dispatch` 会对 filePath 调 `createReadStream`，不存在的路径会异步抛 ENOENT。 */
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'protohub-static-route-'));
const FIXTURE_FILE = join(FIXTURE_DIR, 'app.js');
writeFileSync(FIXTURE_FILE, 'console.log(1)');

afterAll(() => {
  rmSync(FIXTURE_DIR, { force: true, recursive: true });
});

interface CapturedRoute {
  handler: (request: StaticRequest & { method: string }, reply: unknown) => unknown;
  method: string;
  url: string;
}

interface ReplyRecorder {
  readonly bodies: unknown[];
  readonly codes: number[];
  readonly headers: Record<string, string>;
  readonly reply: unknown;
}

function createReplyRecorder(): ReplyRecorder {
  const bodies: unknown[] = [];
  const codes: number[] = [];
  const headers: Record<string, string> = {};
  // 链式返回自身：`reply.code(500).send(...)` 在真 Fastify 上就是这么写的
  const reply = {
    code(status: number): unknown {
      codes.push(status);
      return reply;
    },
    header(name: string, value: string): unknown {
      headers[name] = value;
      return reply;
    },
    send(body?: unknown): unknown {
      bodies.push(body);
      return reply;
    },
  };
  return { bodies, codes, headers, reply };
}

/** `dispatch` 里那条 Promise 要等到下一个宏任务才发得出去（handler 本身是同步返回的）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

const openedStreams: Readable[] = [];

interface Harness {
  readonly captured: CapturedRoute[];
  /** 访问记录的双人桩（M4-T9）：这里只验"路由有没有把服务层的结论送过去"。 */
  readonly record: Mock<(visit: AccessVisit) => void>;
  serveMock: ReturnType<typeof vi.fn>;
  /** 打一次路由：返回 handler 的返回值（必须是 `undefined`）与这次发出去的东西。 */
  invoke: (url: string) => { handlerReturn: unknown; recorder: ReplyRecorder };
}

function harness(
  serveImpl: (request: StaticRequest) => Promise<StaticResponse>,
  envOverrides: Record<string, unknown> = {},
): Harness {
  const serveMock = vi.fn(serveImpl);
  const record = vi.fn();
  const captured: CapturedRoute[] = [];
  const host = {
    httpAdapter: {
      getInstance: () => ({
        route: (config: CapturedRoute): unknown => {
          captured.push(config);
          return undefined;
        },
      }),
    },
  } as unknown as ConstructorParameters<typeof PrototypeStaticRoute>[0];
  const route = new PrototypeStaticRoute(
    host,
    fakeAppEnv({ SERVE_STATIC: 'node', ...envOverrides }),
    { serve: serveMock } as unknown as ConstructorParameters<typeof PrototypeStaticRoute>[2],
    { record } as unknown as ConstructorParameters<typeof PrototypeStaticRoute>[3],
  );
  route.onApplicationBootstrap();

  return {
    captured,
    record,
    serveMock,
    invoke: (url) => {
      const recorder = createReplyRecorder();
      const handlerReturn = captured[0]?.handler(
        { headers: {}, method: 'GET', url },
        recorder.reply,
      );
      return { handlerReturn, recorder };
    },
  };
}

/** 断言"没有第二次发送"的公共前置：调一次、看返回值、等 dispatch 发完。 */
async function sendOnce(h: Harness, url: string): Promise<ReplyRecorder> {
  const { handlerReturn, recorder } = h.invoke(url);
  // Fastify 见到 handler 返回 Promise，会在它 resolve 成 undefined 时替我们再发一次
  // `send(undefined)` → content-length: 0 的空体把响应抢先冲掉，文件永远发不出去。
  expect(handlerReturn).toBeUndefined();
  await flush();
  return recorder;
}

afterEach(() => {
  // 单测不消费流，但 `createReadStream` 真的开了句柄
  for (const stream of openedStreams) {
    stream.destroy();
  }
  openedStreams.length = 0;
});

describe('注册与否只由 SERVE_STATIC 决定', () => {
  it('nginx 部署下连路由都不注册：生产不留第二套鉴权实现', () => {
    const h = harness(async () => ({ headers: {}, status: 404 }), {
      SERVE_STATIC: 'nginx',
    });

    expect(h.captured).toHaveLength(0);
  });

  it('node 直出时注册一条 GET 路由，且吃下 /p/ 下的全部形状', () => {
    const h = harness(async () => ({ headers: {}, status: 404 }));

    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]?.method).toBe('GET');
    // 通配而不是 `/p/:projectCode/:prototypeCode/*`：后者的通配段要求非空，于是
    // `/p/{项目}/{原型}`（少尾斜杠）与 `/p/{项目}`（单段，G6）都落不到这里，
    // 而是掉进 Nest 的默认 404——一枚 JSON 信封，与 nginx 的门面页不同口径（D-05）
    expect(h.captured[0]?.url).toBe('/p/*');
  });
});

describe('一次结论对应一次发送', () => {
  it('放行：状态码、每个响应头、一个流，仅此而已', async () => {
    const h = harness(async () => ({
      filePath: FIXTURE_FILE,
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Length': '15',
        'Content-Type': 'text/javascript; charset=utf-8',
        ETag: '"f-1a112d63c71"',
        'Last-Modified': 'Tue, 06 Oct 2026 20:09:52 GMT',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 200,
    }));

    const recorder = await sendOnce(h, '/p/crm/crm-p01/assets/app.js');

    expect(h.serveMock).toHaveBeenCalledOnce();
    expect(recorder.codes).toEqual([200]);
    expect(recorder.bodies).toHaveLength(1);
    const payload = recorder.bodies[0] as Readable;
    expect(typeof payload?.pipe).toBe('function');
    openedStreams.push(payload);
    expect(recorder.headers).toEqual({
      'Cache-Control': 'no-cache',
      'Content-Length': '15',
      'Content-Type': 'text/javascript; charset=utf-8',
      ETag: '"f-1a112d63c71"',
      'Last-Modified': 'Tue, 06 Oct 2026 20:09:52 GMT',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('门面页：body 原样发出去，不发第二次', async () => {
    const h = harness(async () => ({
      body: '<!doctype html>gate',
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' },
      status: 404,
    }));

    const recorder = await sendOnce(h, '/p/crm');

    expect(recorder.codes).toEqual([404]);
    expect(recorder.bodies).toEqual(['<!doctype html>gate']);
  });

  it('301 没有 body，但 Location 要在（跳转本身不带内容，别把它发成 200 空页）', async () => {
    const h = harness(async () => ({
      headers: { 'Cache-Control': 'no-store', Location: '/p/crm/crm-p01/' },
      status: 301,
    }));

    const recorder = await sendOnce(h, '/p/crm/crm-p01');

    expect(recorder.codes).toEqual([301]);
    expect(recorder.headers.Location).toBe('/p/crm/crm-p01/');
    expect(recorder.bodies).toEqual(['']);
  });

  it('请求里除了 url 与 headers 什么都不传给服务层', async () => {
    const h = harness(async () => ({ headers: {}, status: 404 }));

    await sendOnce(h, '/p/crm/crm-p01/?x=1');

    const served = h.serveMock.mock.calls[0]?.[0] as StaticRequest & { method: string };
    expect(served.url).toBe('/p/crm/crm-p01/?x=1');
    expect(Object.keys(served).sort()).toEqual(['headers', 'method', 'url']);
  });
});

describe('只有"读不了盘"才是这里该出现 500 的情况', () => {
  it('服务层抛出（IO 故障）→ 500 + no-store，错误原文只进日志不进响应', async () => {
    const error = Object.assign(new Error('EIO: disk is dying'), { code: 'EIO' });
    const h = harness(async () => {
      throw error;
    });

    const recorder = await sendOnce(h, '/p/crm/crm-p01/');

    expect(recorder.codes).toEqual([500]);
    expect(recorder.headers['Cache-Control']).toBe('no-store');
    expect(recorder.bodies).toHaveLength(1);
    expect(String(recorder.bodies[0])).not.toMatch(/EIO|disk/);
  });

  it('抛的不是 Error 也要发 500，不能让响应挂在那里', async () => {
    const h = harness(async () => {
      throw 'plain-string-failure';
    });

    const recorder = await sendOnce(h, '/p/crm/crm-p01/');

    expect(recorder.codes).toEqual([500]);
  });
});

describe('访问记录的送交（M4-T9）', () => {
  const entryFacts = {
    isEntry: true,
    projectCode: 'crm',
    prototypeCode: 'crm-p01',
    prototypeId: '31',
    releaseId: '77',
    userId: null,
  };

  it('服务层给出的结论原样送交，路由只补 status / uri / request', async () => {
    const h = harness(async () => ({
      access: entryFacts,
      filePath: FIXTURE_FILE,
      headers: { 'Content-Length': '15' },
      status: 200,
    }));

    await sendOnce(h, '/p/crm/crm-p01/index.html?utm=1');

    const sent = h.record.mock.calls[0]?.[0] as AccessVisit;
    expect(h.record).toHaveBeenCalledOnce();
    expect(sent).toMatchObject({ ...entryFacts, status: 200 });
    // uri 用原始 url（含查询串）：查询串可能带临时口令，`record` 那侧会截掉，不在这里丢信息
    expect(sent.uri).toBe('/p/crm/crm-p01/index.html?utm=1');
    expect(sent.request).toBeTruthy();
  });

  it('判定发生在发送之前：文件流还没打开就已经记上', async () => {
    const order: string[] = [];
    const h = harness(async () => {
      order.push('serve');
      return { access: entryFacts, headers: {}, status: 401 };
    });
    h.record.mockImplementation(() => {
      order.push('record');
    });

    const { handlerReturn, recorder } = h.invoke('/p/crm/crm-p01/');
    expect(handlerReturn).toBeUndefined();
    // `dispatch` 在 `reply.code/send` 之前调 record，所以这里只等到宏任务就该看到两条顺序
    await flush();

    expect(order).toEqual(['serve', 'record']);
    expect(recorder.codes).toEqual([401]);
  });

  it.each([
    ['301 补尾斜杠', { headers: { Location: '/p/crm/crm-p01/' }, status: 301 }],
    [
      '304 命中缓存',
      { headers: { ETag: '"f-1a112d63c71"' }, status: 304 } as StaticResponse,
    ],
  ] as const)('%s：没有 access 结论就不记（机制 §6 的"缓存与跳转不参与统计"）', async (_label, response) => {
    const h = harness(async () => response);

    await sendOnce(h, '/p/crm/crm-p01');

    expect(h.record).not.toHaveBeenCalled();
  });

  it('直出失败（500）不记：连文件在哪都没定下来，记了只会污染无效链接那一档', async () => {
    const h = harness(async () => {
      throw new Error('EIO');
    });

    await sendOnce(h, '/p/crm/crm-p01/');

    expect(h.record).not.toHaveBeenCalled();
  });

  it('被拒也送交：node 直出没有 nginx 那一跳，401/403 只能在这里记', async () => {
    const h = harness(async () => ({
      access: { ...entryFacts, isEntry: false },
      body: '<!doctype html>gate',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status: 401,
    }));

    await sendOnce(h, '/p/crm/crm-p01/assets/app.js');

    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record.mock.calls[0]?.[0]).toMatchObject({
      isEntry: false,
      prototypeId: '31',
      status: 401,
    });
  });
});

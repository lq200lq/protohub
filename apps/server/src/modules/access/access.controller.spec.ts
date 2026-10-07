import { describe, expect, it, vi, type Mock } from 'vitest';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { ERROR_CODES, type AccessReason } from '@protohub/shared';

import { IS_PUBLIC_KEY } from '../../common/decorator/public.decorator';
import { CookieService } from '../../common/permission/cookie.service';
import { BusinessException } from '../../common/exception/business.exception';
import { SKIP_ENVELOPE_KEY } from '../../common/response/skip-envelope.decorator';
import { createReplyCapture, createRequest } from '../../testing/nest-context.fixture';
import { fakeAppEnv } from '../../testing/app-env.fixture';
import {
  ORIGINAL_URI_HEADER,
  PROTO_REASON_HEADER,
  PROTO_RELEASE_DIR_HEADER,
  REAL_IP_HEADER,
} from '../../config/constants';
import { AccessController } from './access.controller';
import type { AccessOutcome, AccessQuery, AccessService } from './access.service';
import type { AccessRows, AccessRepo } from './access.repo';
import type { UnlockRequest, UnlockResult, UnlockService } from './unlock.service';
import type {
  AccessLogRecorderService,
  AccessVisit,
} from '../accesslog/access-log.recorder.service';

/**
 * `/api/access/check` 的 nginx 契约（迭代实施计划 M4-T3 的 C1–C4；接口设计 §9.1）。
 *
 * 只桩 `AccessService`：来源白名单、URI 解析、Cookie 读取与信封全都是真的实现——
 * 这四样加响应头正是这个接口唯一的责任，桩掉它们就等于什么都没测。
 */
const LAN = fakeAppEnv({ ACCESS_CHECK_ALLOW_CIDRS: '127.0.0.1/32' });
const LOCAL = { [REAL_IP_HEADER]: '127.0.0.1' };

/** check 那几条用例不关心解锁，给一个永不为错的桩（`unlock` 路由自己的用例里换掉）。 */
const UNLOCK_STUB = {
  unlock: async (): Promise<UnlockResult> => ({ kind: 'already-open' }),
} as unknown as UnlockService;

/**
 * 访问记录的双人桩（M4-T9）。控制器只把"这次判定"交给 recorder，记不记、记成什么行是
 * `record-policy.ts` 与 recorder 自己的事（各自的单测在 accesslog 模块里）——所以这里
 * 断言的只有"哪几次判定被送了过来、送的是哪个状态码"。
 */
interface AccessLogDouble {
  readonly record: Mock<(visit: AccessVisit) => void>;
  readonly service: AccessLogRecorderService;
}

function accessLogDouble(): AccessLogDouble {
  const record = vi.fn();
  return { record, service: { record } as unknown as AccessLogRecorderService };
}

/**
 * 不关心访问记录的那几条路由（解锁、门面页形态、C3/C4）共用这一个占位双：
 * 它只保证构造函数不缺参数，没人对它做断言。
 */
const accessLog = accessLogDouble();

/** `gate()` 记录那一条会查一次行；桩成"查不到"即可（`recordGateMiss` 查不到也照样记）。 */
const EMPTY_ROWS: AccessRows = { project: null, prototype: null };
function repoDouble(rows: AccessRows = EMPTY_ROWS): AccessRepo {
  return { findRowsByCodes: async () => rows } as unknown as AccessRepo;
}

function allowedOutcome(): AccessOutcome {
  return {
    decision: { releaseId: '77', status: 200 },
    projectId: '9',
    prototypeId: '31',
    sessionUserId: null,
  };
}

function deniedOutcome(reason: AccessReason, status: 401 | 403 | 404): AccessOutcome {
  return {
    decision: { reason, status },
    projectId: '9',
    prototypeId: '31',
    sessionUserId: null,
  };
}

interface Harness {
  readonly accessLog: AccessLogDouble;
  readonly capture: ReturnType<typeof createReplyCapture>;
  readonly decide: Mock<(query: AccessQuery) => Promise<AccessOutcome>>;
  run: (headers?: Record<string, unknown>) => Promise<void>;
}

function harness(outcome: AccessOutcome): Harness {
  const capture = createReplyCapture();
  const decide = vi.fn(async (_query: AccessQuery) => outcome);
  const log = accessLogDouble();
  const controller = new AccessController(
    // 只用到 decide 一个方法；Nest 的 DI 在运行时也只注入这个方法，结构上成立。
    { decide } as unknown as AccessService,
    log.service,
    repoDouble(),
    new CookieService(LAN),
    LAN,
    UNLOCK_STUB,
  );
  return {
    accessLog: log,
    capture,
    decide,
    run: async (headers = {}) => {
      await controller.check(
        createRequest({ ...LOCAL, ...headers }),
        capture.reply,
      );
    },
  };
}

describe('C3：来源白名单先于一切判定', () => {
  it('公网 X-Real-IP → 403 + SOURCE_NOT_ALLOWED，并且一次都不查库', async () => {
    const { capture, decide, run } = harness(allowedOutcome());

    await run({ [REAL_IP_HEADER]: '8.8.8.8', [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(decide).not.toHaveBeenCalled();
    expect(capture.statusCodes).toEqual([403]);
    expect(capture.headers[PROTO_REASON_HEADER]).toBe('SOURCE_NOT_ALLOWED');
    expect(capture.bodies[0]).toMatchObject({
      code: -1,
      errorCode: ERROR_CODES.ACCESS_SOURCE_FORBIDDEN,
    });
  });

  it('缺 X-Real-IP 同样 403（少了来源就没法证明请求来自 nginx）', async () => {
    const { capture, decide, run } = harness(allowedOutcome());

    await run({ [REAL_IP_HEADER]: undefined });

    expect(decide).not.toHaveBeenCalled();
    expect(capture.statusCodes).toEqual([403]);
  });

  it('畸形来源（不是 IP）也拒；白名单可以配多段', async () => {
    const lan = fakeAppEnv({ ACCESS_CHECK_ALLOW_CIDRS: '127.0.0.1/32, 10.0.0.0/8' });
    const capture = createReplyCapture();
    const decide = vi.fn(async () => allowedOutcome());
    const controller = new AccessController(
      { decide } as unknown as AccessService,
      accessLog.service,
      repoDouble(),
      new CookieService(lan),
      lan,
      UNLOCK_STUB,
    );

    await controller.check(
      createRequest({ ...LOCAL, [REAL_IP_HEADER]: 'localhost' }),
      capture.reply,
    );
    expect(capture.statusCodes).toEqual([403]);

    decide.mockClear();
    await controller.check(
      createRequest({ [REAL_IP_HEADER]: '10.1.2.3', [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' }),
      capture.reply,
    );
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe('URI 解析不出来的形态统一 404', () => {
  it.each([
    ['/p/crm', '只有一段路径（G6：不能落到管理台）'],
    ['/admin/projects', '不是 /p/ 前缀'],
    ['/p/crm//index.html', '中间空段'],
    ['/p/CRM/CRM-P01/', '大写编码不合法'],
    ['/p/crm/crm-p01%2F../../etc/passwd', '编码里塞路径穿越'],
    ['', '空头'],
  ])('%s → 404（%s）', async (uri) => {
    const { capture, decide, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: uri });

    expect(decide).not.toHaveBeenCalled();
    expect(capture.statusCodes).toEqual([404]);
    expect(capture.headers[PROTO_REASON_HEADER]).toBe('NOT_FOUND');
  });
});

describe('C1：200 必带 X-Proto-Release-Dir', () => {
  it('形状 releases/{项目ID}/{原型ID}/{版本ID}，取自同一次决策的三个 id', async () => {
    const { capture, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/index.html' });

    expect(capture.statusCodes).toEqual([200]);
    expect(capture.headers[PROTO_RELEASE_DIR_HEADER]).toBe('releases/9/31/77');
    // 放行时不该有原因头：nginx 只在 401/403/404 时用它选门面页形态
    expect(capture.headers[PROTO_REASON_HEADER]).toBeUndefined();
    expect(capture.bodies[0]).toEqual({
      code: 0,
      data: { reason: null, releaseDir: 'releases/9/31/77' },
      error: null,
      message: 'ok',
    });
  });

  it('决策说 200 却没有目录时收敛成 404，绝不出现第五种状态码', async () => {
    const { capture, run } = harness({
      ...allowedOutcome(),
      prototypeId: null,
    });

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(capture.statusCodes).toEqual([404]);
    expect(capture.headers[PROTO_RELEASE_DIR_HEADER]).toBeUndefined();
  });
});

describe('C2：401/403/404 必带 X-Proto-Reason', () => {
  it.each([
    ['NEED_PASSWORD', 401],
    ['NEED_LOGIN', 403],
    ['NO_PERMISSION', 403],
    ['PROTOTYPE_ARCHIVED', 403],
    ['PROJECT_ARCHIVED', 403],
    ['NOT_FOUND', 404],
    ['NOT_PUBLISHED', 404],
  ] as const)('%s → %d', async (reason, status) => {
    const { capture, run } = harness(deniedOutcome(reason, status));

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(capture.statusCodes).toEqual([status]);
    expect(capture.headers[PROTO_REASON_HEADER]).toBe(reason);
    expect(capture.bodies[0]).toMatchObject({
      code: -1,
      // 原因码就是对外错误码，不再造第二套名字
      errorCode: reason,
    });
  });

  it('被拒的响应体不回显任何业务信息（只有固定文案）', async () => {
    const { capture, run } = harness(deniedOutcome('NO_PERMISSION', 403));

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    const body = capture.bodies[0] as { data: unknown; error: string };
    expect(body.data).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/crm|客户|原型名/);
  });
});

describe('C4：身份只从 Cookie 读，不接受任何凭据参数', () => {
  it('服务层拿到的 readCookie 能读出两个 Cookie，读不出 query 里的同名参数', async () => {
    const capture = createReplyCapture();
    const decide = vi.fn(async (query: AccessQuery) => {
      expect(query.readCookie('proto_sess')).toBe('v1.42.3.9.sig');
      expect(query.readCookie('proto_access_p31')).toBe('v1.2.9.sig');
      expect(query.readCookie('token')).toBeUndefined();
      // 传进服务层的只有两段编码与一个读 Cookie 的口子：传输层对象不外泄
      expect(Object.keys(query).sort()).toEqual(['projectCode', 'prototypeCode', 'readCookie']);
      return deniedOutcome('NEED_LOGIN', 403);
    });
    const controller = new AccessController(
      { decide } as unknown as AccessService,
      accessLog.service,
      repoDouble(),
      new CookieService(LAN),
      LAN,
      UNLOCK_STUB,
    );

    await controller.check(
      createRequest(
        {
          ...LOCAL,
          [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/index.html?x=1',
          authorization: 'Bearer forged',
          cookie: 'proto_sess=v1.42.3.9.sig; proto_access_p31=v1.2.9.sig',
        },
        { url: '/api/access/check?token=forged' },
      ),
      capture.reply,
    );

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
    });
    expect(capture.statusCodes).toEqual([403]);
  });
});

/**
 * 门面页路由（M4-T6）。渲染本身在 `gate-page.spec.ts` 逐形态验，这里只管路由的三件事：
 * 谁能访问、带什么响应头、登录地址从哪来。
 */
describe('GET /api/access/gate', () => {
  const controller = new AccessController(
    { decide: async () => allowedOutcome() } as unknown as AccessService,
    accessLog.service,
    repoDouble(),
    new CookieService(LAN),
    LAN,
    UNLOCK_STUB,
  );

  it('必须免登录且不套信封：nginx 要给没登录的人取这一页，包成 {code,data} 就不是 HTML 了', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.gate)).toBe(true);
    expect(Reflect.getMetadata(SKIP_ENVELOPE_KEY, controller.gate)).toBe(true);
  });

  it('响应头写死 text/html 与 no-store（机制 §7：改完密码立刻要重新看到这一页）', () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, controller.gate) as Array<{
      name: string;
      value: string;
    }>;

    expect(headers).toEqual(
      expect.arrayContaining([
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ]),
    );
  });

  it('查询串原样交给渲染器，「去登录」的地址用配置里的 PUBLIC_BASE_URL 拼', () => {
    const html = controller.gate(createRequest(), {
      code: '403',
      from: '/p/crm/crm-p01/',
      reason: 'NEED_LOGIN',
    });

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(
      'href="http://127.0.0.1:3100/auth/login?redirect=%2Fp%2Fcrm%2Fcrm-p01%2F"',
    );
  });
});

/**
 * 解锁路由（M4-T7；接口设计 §9.2）。
 *
 * 桩的只有 `UnlockService.unlock`——Cookie 拼装走真的 `CookieService`，因为这一条接口对外
 * 承诺的就是那个 `Set-Cookie` 字符串，属性拼错一个字节浏览器就不存它。
 */
describe('POST /api/access/{项目编码}/{原型编码}/unlock', () => {
  const unlockedResult: UnlockResult = {
    cookieName: 'proto_access_p31',
    cookiePath: '/p/crm/crm-p01',
    cookieValue: 'v1.7.1893456000.abcdef',
    kind: 'unlocked',
    maxAgeSeconds: 86400,
  };

  interface UnlockHarness {
    readonly capture: ReturnType<typeof createReplyCapture>;
    readonly unlock: Mock<(request: UnlockRequest) => Promise<UnlockResult>>;
    run: (input?: {
      body?: unknown;
      headers?: Record<string, unknown>;
      projectCode?: string;
      prototypeCode?: string;
    }) => Promise<void>;
  }

  function unlockHarness(result: UnlockResult | Error): UnlockHarness {
    const capture = createReplyCapture();
    const unlock = vi.fn(async (): Promise<UnlockResult> => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    });
    const controller = new AccessController(
      { decide: async () => allowedOutcome() } as unknown as AccessService,
      accessLog.service,
      repoDouble(),
      new CookieService(LAN),
      LAN,
      { unlock } as unknown as UnlockService,
    );
    return {
      capture,
      unlock,
      run: (input = {}) =>
        controller.unlock(
          createRequest({ ...LOCAL, ...input.headers }),
          capture.reply,
          input.projectCode ?? 'crm',
          input.prototypeCode ?? 'crm-p01',
          // 用 `in` 而不是判空：`{ body: undefined }` 是"根本没带 body"这一条用例，
          // 与"带了但形态不对"要分开走。
          'body' in input ? input.body : { password: 'hunter2' },
        ),
    };
  }

  it('免登录、不套信封（表单来自门面页，访问者还没有任何身份）', () => {
    const controller = new AccessController(
      { decide: async () => allowedOutcome() } as unknown as AccessService,
      accessLog.service,
      repoDouble(),
      new CookieService(LAN),
      LAN,
      UNLOCK_STUB,
    );

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, controller.unlock)).toBe(true);
    expect(Reflect.getMetadata(SKIP_ENVELOPE_KEY, controller.unlock)).toBe(true);
  });

  it('解锁成功：200 + 一条原型级 Cookie，Path 只覆盖这一条链接', async () => {
    const { capture, run } = unlockHarness(unlockedResult);

    await run();

    expect(capture.statusCodes).toEqual([200]);
    expect(capture.bodies[0]).toEqual({
      code: 0,
      data: null,
      error: null,
      message: 'ok',
    });
    expect(capture.headers['set-cookie']).toBe(
      'proto_access_p31=v1.7.1893456000.abcdef; Path=/p/crm/crm-p01; HttpOnly; SameSite=Lax; Max-Age=86400',
    );
    // 令牌值原样落下，不在控制器里做任何二次加工（加工是 UnlockTokenService 的事）
    expect(capture.headers['set-cookie']).toContain(unlockedResult.cookieValue);
  });

  it('开发环境不带 Secure；配了 secure 的形态下必须带（Cookie 存不存得下由它决定）', async () => {
    const { capture, run } = unlockHarness(unlockedResult);
    await run();
    expect(capture.headers['set-cookie']).not.toContain('Secure');

    const secureEnv = fakeAppEnv({ NODE_ENV: 'production' });
    const secureCapture = createReplyCapture();
    const secureController = new AccessController(
      { decide: async () => allowedOutcome() } as unknown as AccessService,
      accessLog.service,
      repoDouble(),
      new CookieService(secureEnv),
      secureEnv,
      {
        unlock: async (): Promise<UnlockResult> => unlockedResult,
      } as unknown as UnlockService,
    );
    await secureController.unlock(
      createRequest(LOCAL),
      secureCapture.reply,
      'crm',
      'crm-p01',
      { password: 'hunter2' },
    );
    expect(secureCapture.headers['set-cookie']).toContain('Secure');
  });

  it.each([
    ['{ }', {}],
    ['空串', { password: '' }],
    ['73 个字符', { password: 'x'.repeat(73) }],
    ['多带一个字段', { password: 'hunter2', admin: true }],
    ['不是对象', 'hunter2'],
    ['缺 body', undefined],
  ])('请求体形态不对（%s）→ 400 PARAM_INVALID，且不碰任何判定', async (_label, body) => {
    const { capture, run, unlock } = unlockHarness(unlockedResult);

    const error = await run({ body }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).errorCode).toBe(ERROR_CODES.PARAM_INVALID);
    expect((error as BusinessException).httpStatus).toBe(400);
    expect(unlock).not.toHaveBeenCalled();
    expect(capture.statusCodes).toEqual([]);
  });

  it('带空格的密码先 trim 再验（设密码那侧就是 trim 过的）', async () => {
    const { run, unlock } = unlockHarness(unlockedResult);

    await run({ body: { password: '  hunter2  ' } });

    expect(unlock.mock.calls[0]?.[0].password).toBe('hunter2');
  });

  it.each([
    ['CRM', 'crm-p01', '大写项目码'],
    ['crm', 'CRM-P01', '大写原型码'],
    ['crm', 'a/b', '原型码里带斜杠'],
    ['', 'crm-p01', '空项目码'],
  ])('编码不合法（%s）→ 404，与那条链接同一个状态（不给枚举留缝）', async (_project, prototype, _label) => {
    const { capture, run, unlock } = unlockHarness(unlockedResult);

    await run({ projectCode: _project, prototypeCode: prototype });

    expect(unlock).not.toHaveBeenCalled();
    expect(capture.statusCodes).toEqual([404]);
    expect(capture.headers[PROTO_REASON_HEADER]).toBe('NOT_FOUND');
    expect(capture.headers['set-cookie']).toBeUndefined();
  });

  it('密码不对：403 + ACCESS_BAD_PASSWORD，固定文案里不透露剩余次数', async () => {
    const { capture, run } = unlockHarness({ kind: 'bad-password' });

    await run();

    expect(capture.statusCodes).toEqual([403]);
    expect(capture.bodies[0]).toMatchObject({
      code: -1,
      errorCode: ERROR_CODES.ACCESS_BAD_PASSWORD,
      error: '访问密码不对，请再试一次',
    });
    expect(capture.headers['set-cookie']).toBeUndefined();
    expect(capture.headers[PROTO_REASON_HEADER]).toBeUndefined();
  });

  it.each([
    ['NEED_LOGIN', 403],
    ['NO_PERMISSION', 403],
    ['PROTOTYPE_ARCHIVED', 403],
    ['PROJECT_ARCHIVED', 403],
    ['NOT_FOUND', 404],
    ['NOT_PUBLISHED', 404],
  ] as const)('决策已经拦下（%s → %d）时不再验密码，响应与 check 同形', async (reason, status) => {
    const { capture, run } = unlockHarness({ kind: 'denied', reason, status });

    await run();

    expect(capture.statusCodes).toEqual([status]);
    expect(capture.headers[PROTO_REASON_HEADER]).toBe(reason);
    expect(capture.bodies[0]).toMatchObject({ code: -1, errorCode: reason });
    expect(capture.headers['set-cookie']).toBeUndefined();
  });

  it('public 档（无需密码）也给 200，但不发 Cookie——没有东西可发', async () => {
    const { capture, run } = unlockHarness({ kind: 'already-open' });

    await run();

    expect(capture.statusCodes).toEqual([200]);
    expect(capture.bodies[0]).toMatchObject({ code: 0, data: null });
    expect(capture.headers['set-cookie']).toBeUndefined();
  });

  it('锁住的 429 由服务层抛出，交全局过滤器出信封（这里不吞、不改写文案）', async () => {
    const { run, capture } = unlockHarness(
      new BusinessException('失败次数过多，请 10 分钟后再试', ERROR_CODES.RATE_LIMITED, 429),
    );

    const error = await run().catch((caught: unknown) => caught);

    expect((error as BusinessException).errorCode).toBe(ERROR_CODES.RATE_LIMITED);
    expect((error as BusinessException).httpStatus).toBe(429);
    expect(capture.statusCodes).toEqual([]);
  });

  it('来源 IP 与服务层同一个取法：X-Real-IP 优先，缺了才退 XFF 首段', async () => {
    const firstHop = unlockHarness(unlockedResult);
    await firstHop.run({ headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' } });
    expect(firstHop.unlock.mock.calls[0]?.[0].ip).toBe('203.0.113.9');

    const secondHop = unlockHarness(unlockedResult);
    await secondHop.run({
      headers: { [REAL_IP_HEADER]: undefined, 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    });
    expect(secondHop.unlock.mock.calls[0]?.[0].ip).toBe('198.51.100.7');
  });

  it('传给服务层的只有四样：两段编码、密码、IP（凭据不进、请求对象不外泄）', async () => {
    const { run, unlock } = unlockHarness(unlockedResult);

    await run({ body: { password: 'hunter2' } });

    expect(Object.keys(unlock.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'ip',
      'password',
      'projectCode',
      'prototypeCode',
    ]);
  });
});

/**
 * 访问记录的**记录点**（机制 §6；迭代实施计划 M4-T9）。
 *
 * 这里只验"哪几次判定被送进 recorder、送的是哪个状态码/哪一个入口形状"——
 * 要不要落库那张表在 `record-policy.ts` 自己的单测里逐行钉，行形状与批量写在 accesslog 模块测。
 * 分界线画在这里是因为：控制器一旦漏送一次，统计就永久少一类数据，而策略层不可能发现它。
 */
describe('check 的记录点（M4-T9）', () => {
  it('入口文档放行 → 送一条 ok，带上决策给的三个 id', async () => {
    const { accessLog, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({
      isEntry: true,
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      prototypeId: '31',
      releaseId: '77',
      status: 200,
      uri: '/p/crm/crm-p01/',
      userId: null,
    });
  });

  it('入口文档那一条的 uri 用原始 URI（查询串留给 recorder 处理，不在这里丢信息）', async () => {
    const { accessLog, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/index.html?utm=1' });

    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({
      isEntry: true,
      status: 200,
      uri: '/p/crm/crm-p01/index.html?utm=1',
    });
  });

  it('member 档判定出的登录用户跟着记录走（§6.1 的 visitorName 只有这一路来源）', async () => {
    const outcome: AccessOutcome = { ...allowedOutcome(), sessionUserId: '42' };
    const { accessLog, run } = harness(outcome);

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({ userId: '42' });
  });

  it('资源请求的 200 照样送到 recorder，但 isEntry=false——"不记"是策略层判的，不在这里再写一遍 if', async () => {
    const { accessLog, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/assets/app.js' });

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({ isEntry: false, status: 200 });
  });

  it.each([
    ['NEED_PASSWORD', 401],
    ['NO_PERMISSION', 403],
    ['NOT_FOUND', 404],
  ] as const)('%s 的资源请求照样送（被拦的人不该因为"不是入口"而消失）', async (reason, status) => {
    const { accessLog, run } = harness(deniedOutcome(reason, status));

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/assets/app.js' });

    // 唯一的例外是 404：那一跳 nginx 会接着转到门面页，由那里记（见下面 gate 那组用例）
    expect(accessLog.record).toHaveBeenCalledTimes(status === 404 ? 0 : 1);
  });

  it('入口文档被拒 → 送对应状态码（编码不存在的那一类靠 route_key 定位，id 全空）', async () => {
    const { accessLog, run } = harness({
      ...deniedOutcome('NOT_FOUND', 404),
      projectId: null,
      prototypeId: null,
    });

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p99/' });

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({
      isEntry: true,
      projectCode: 'crm',
      prototypeCode: 'crm-p99',
      prototypeId: null,
      releaseId: undefined,
      status: 404,
    });
  });

  it('决策放行却没有版本目录（数据与决策对不上）→ 送 404，不是"什么都不记"', async () => {
    const outcome: AccessOutcome = {
      ...allowedOutcome(),
      decision: { releaseId: undefined, status: 200 },
    };
    const { accessLog, run } = harness(outcome);

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record.mock.calls[0]?.[0]).toMatchObject({ status: 404 });
  });

  it('来源被白名单拒掉时不送：那是探测流量，写库等于让探测者按我们的表打我们', async () => {
    const { accessLog, run } = harness(allowedOutcome());

    await run({ [REAL_IP_HEADER]: '8.8.8.8', [ORIGINAL_URI_HEADER]: '/p/crm/crm-p01/' });

    expect(accessLog.record).not.toHaveBeenCalled();
  });

  it('URI 解析不出两段编码时不送（route_key 是 NOT NULL，没有可归属的对象）', async () => {
    const { accessLog, run } = harness(allowedOutcome());

    await run({ [ORIGINAL_URI_HEADER]: '/p/crm' });

    expect(accessLog.record).not.toHaveBeenCalled();
  });
});

/**
 * 门面页作为"线上资源 404"的唯一记录点（机制 §6 表最后一行）。
 *
 * nginx 模式下文件缺失是静态处理器发现的，它只会按 `error_page 404` 转到这里并把原始 URI 放进
 * `from`；`check` 当时不知道文件在不在。所以这一跳不记，那条"白屏线索"在线上就没有第二个来源。
 */
describe('gate 的记录点（M4-T9）', () => {
  const PUBLISHED_ROWS: AccessRows = {
    project: null,
    prototype: {
      accessMode: 'public',
      currentReleaseId: '77',
      deletedAt: null,
      id: '31',
      policyVersion: 1,
      status: 'published',
    },
  };

  interface GateHarness {
    readonly findRowsByCodes: Mock<(p: string, q: string) => Promise<AccessRows>>;
    readonly record: Mock<(visit: AccessVisit) => void>;
    run: (query: Record<string, unknown>) => void;
  }

  function gateHarness(rows: AccessRows | Error): GateHarness {
    const record = vi.fn();
    const findRowsByCodes = vi.fn(async (): Promise<AccessRows> => {
      if (rows instanceof Error) {
        throw rows;
      }
      return rows;
    });
    const controller = new AccessController(
      { decide: async () => allowedOutcome() } as unknown as AccessService,
      { record } as unknown as AccessLogRecorderService,
      { findRowsByCodes } as unknown as AccessRepo,
      new CookieService(LAN),
      LAN,
      UNLOCK_STUB,
    );
    return {
      findRowsByCodes,
      record,
      run: (query) => {
        controller.gate(createRequest({ [REAL_IP_HEADER]: '127.0.0.1' }), query);
      },
    };
  }

  /**
   * 记录点在门面页是 fire-and-forget（正文不能为统计等一次查库），断言前把微任务队列排空：
   * 一个 0ms 的定时器一定排在所有已挂起的 promise 之后，比 `await Promise.resolve()` 稳。
   */
  async function settled(): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  it('404 + 非入口的 from → 记一条 not_found，并补上原型与版本 id（否则列表页会把它显示成无效链接）', async () => {
    const { record, run } = gateHarness(PUBLISHED_ROWS);

    run({
      code: '404',
      from: '/p/crm/crm-p01/assets/app.js',
      project: 'crm',
      prototype: 'crm-p01',
    });
    await settled();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      isEntry: false,
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      prototypeId: '31',
      releaseId: '77',
      status: 404,
      uri: '/p/crm/crm-p01/assets/app.js',
    });
  });

  it.each([
    ['401', '/p/crm/crm-p01/assets/app.js'],
    ['403', '/p/crm/crm-p01/assets/app.js'],
    ['404', '/p/crm/crm-p01/'],
    ['404', '/p/crm/crm-p01/index.html'],
  ])('code=%s、from=%s 不记：那几种 check 已经记过，两处都记就是同一次访问两条', async (code, from) => {
    const { record, run } = gateHarness(PUBLISHED_ROWS);

    run({ code, from, project: 'crm', prototype: 'crm-p01' });
    await settled();

    expect(record).not.toHaveBeenCalled();
  });

  it('from 缺失、不是站内 /p/ 路径、或解析不出两段编码 → 不记', async () => {
    const { record, run } = gateHarness(PUBLISHED_ROWS);

    run({ code: '404', project: 'crm', prototype: 'crm-p01' });
    run({ code: '404', from: 'https://evil.example/a.js', project: 'crm', prototype: 'crm-p01' });
    run({ code: '404', from: '/p/crm', project: 'crm', prototype: 'crm-p01' });
    await settled();

    expect(record).not.toHaveBeenCalled();
  });

  it('查行失败也照记：这条记录的意义是"有人请求了这个路径"，id 只是加分项', async () => {
    const { record, run } = gateHarness(new Error('db down'));

    run({
      code: '404',
      from: '/p/crm/crm-p99/assets/app.js',
      project: 'crm',
      prototype: 'crm-p99',
    });
    await settled();

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({
      prototypeId: null,
      releaseId: null,
      status: 404,
    });
  });

  it('记完仍然要返回 HTML：统计不能改变这一页的任何输出', () => {
    const gate = gateHarness(PUBLISHED_ROWS);

    expect(() =>
      gate.run({
        code: '404',
        from: '/p/crm/crm-p01/assets/app.js',
        project: 'crm',
        prototype: 'crm-p01',
      }),
    ).not.toThrow();
  });
});

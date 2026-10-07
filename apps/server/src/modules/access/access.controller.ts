import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ERROR_CODES,
  isValidProjectCode,
  isValidPrototypeCode,
  type AccessReason,
} from '@protohub/shared';
import { z } from 'zod';

import { Public } from '../../common/decorator/public.decorator';
import {
  readRequestHeader,
  setResponseHeader,
  type HttpReplyLike,
  type TraceableRequest,
} from '../../common/http-types';
import { toErrorEnvelope, toSuccessEnvelope } from '../../common/response/api-envelope';
import { SkipEnvelope } from '../../common/response/skip-envelope.decorator';
import { CookieService } from '../../common/permission/cookie.service';
import { BusinessException } from '../../common/exception/business.exception';
import { AppEnvService } from '../../config/app-env.service';
import {
  ORIGINAL_URI_HEADER,
  PROTO_REASON_HEADER,
  PROTO_RELEASE_DIR_HEADER,
  REAL_IP_HEADER,
} from '../../config/constants';
import { releaseKey } from '../storage/storage-keys';
import { clientIpOf } from '../auth/client-request';
import { AccessLogRecorderService } from '../accesslog/access-log.recorder.service';
import { AccessRepo } from './access.repo';
import { AccessService, type AccessOutcome } from './access.service';
import { isEntryDocument, parseAccessUri, type AccessTarget } from './access-uri';
import { parseGateQuery, renderGatePage } from './gate-page';
import { isAllowedSource } from './source-allowlist';
import { UnlockService, type UnlockResult } from './unlock.service';

/**
 * 来源被白名单拒掉时的 `X-Proto-Reason`。
 *
 * 它**不在**接口设计 §9.1 的七个原因里：那七个是"原型存在但访问不过"的原因，由门面页选形态用；
 * 这一条根本不是门面页的分支（正常部署下 nginx 只会用 `$remote_addr` 打这个口），
 * 出现的唯一场景是有人把这个接口当权限探测 API 直连。给它一个独立原因码，是为了让日志里
 * "被探测"和"客户没权限"不混成同一条（计划 §9.2 已记这条差异）。
 */
const SOURCE_NOT_ALLOWED = 'SOURCE_NOT_ALLOWED' as const;

/** `X-Proto-Reason` 的取值域：§9.1 的七个原因加上这一条探测专用原因。 */
type DenyReason = AccessReason | typeof SOURCE_NOT_ALLOWED;

/**
 * 解锁请求体（§9.2：`{ "password": "..." }`）。
 *
 * 上限 72 字符与**设密码**那侧同一条（`prototype.dto` 的 `passwordField`）：argon2 的耗时随输入
 * 线性增长，不设上限就是拿 10MB 当密码把这台机器点着。超了不是"密码错"而是 `PARAM_INVALID`——
 * 一个 72 字符以上的串不可能是这里任何原型的正确密码，拒在它进哈希函数之前更便宜也更诚实。
 *
 * 空串按 `PARAM_INVALID` 同样不计数：门面页的表单有 `required`，走到这一步的空串要么是脚本
 * 要么是浏览器自动填充的半成品，让它消耗"5 次"里的一次只会误伤真人。
 */
const unlockBodySchema = z
  .object({
    // 与**设密码**那侧同一次 trim（`prototype.dto` 的 `passwordField`）：带尾空格的密码在设置时
    // 就已经被削掉了，验的时候不削就会出现"粘贴同一个串，设置能过、输入不能过"。
    password: z.preprocess(
      (value: unknown) => (typeof value === 'string' ? value.trim() : value),
      z.string().min(1).max(72),
    ),
  })
  .strict();

function parseUnlockBody(body: unknown): string {
  const parsed = unlockBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new BusinessException(
      '请输入访问密码（最长 72 个字符）',
      ERROR_CODES.PARAM_INVALID,
      HttpStatus.BAD_REQUEST,
    );
  }
  return parsed.data.password;
}

/**
 * nginx `auth_request` 的决策接口（[后端接口设计.md](../../../../../docs/后端接口设计.md) §9.1；
 * [原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5、§7.1；迭代实施计划 M4-T3）。
 *
 * 契约（四条都在单测里逐条钉住）：
 * - C1 `200` 必带 `X-Proto-Release-Dir`，形状 `releases/{数字}/{数字}/{数字}`（nginx 用白名单 map 取用）
 * - C2 `401/403/404` 必带 `X-Proto-Reason`
 * - C3 非内网 `X-Real-IP` → `403`
 * - C4 不接受任何凭据参数：`Authorization`/query/body 里的 token 一律不认，身份只从 Cookie 读
 *
 * 状态码只有四种：nginx 的 `error_page` 按这四种分派门面页，出现第五种（比如 500）会让原型页面
 * 变成 nginx 默认错误页，所以这里的任何不一致都收敛成 `404`。
 *
 * 响应形态自己管（`@Res()` 非 passthrough + `@SkipEnvelope()`）：状态码要随决策变，
 * 交给 Nest 的拦截器就只能是 200。
 */
@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly accessService: AccessService,
    private readonly accessLog: AccessLogRecorderService,
    private readonly accessRepo: AccessRepo,
    private readonly cookies: CookieService,
    private readonly env: AppEnvService,
    private readonly unlockService: UnlockService,
  ) {}

  @Public()
  @SkipEnvelope()
  @Get('check')
  @ApiOperation({
    summary: '访问决策（内部接口，供 nginx auth_request）',
    operationId: 'accessCheck',
  })
  async check(
    @Req() request: TraceableRequest,
    @Res() reply: HttpReplyLike,
  ): Promise<void> {
    // C3 在最前面：来源不合法时连"这个编码存不存在"都不该被问出来。
    if (
      !isAllowedSource(
        readRequestHeader(request, REAL_IP_HEADER),
        this.env.env.access.checkAllowCidrs,
      )
    ) {
      // 这是本接口唯一的"非决策"分支：原因码给 nginx 看，错误码给人和日志看。
      this.deny(reply, 403, SOURCE_NOT_ALLOWED, ERROR_CODES.ACCESS_SOURCE_FORBIDDEN);
      return;
    }

    const target = parseAccessUri(readRequestHeader(request, ORIGINAL_URI_HEADER));
    if (target === null) {
      //  URI 解析不出来（不是 `/p/` 前缀、只有一段、编码非法）：与"编码不存在"同一个 404，
      // 不给状态差，也就不能被用来枚举编码（R-9）。
      this.deny(reply, 404, 'NOT_FOUND');
      return;
    }

    const outcome = await this.accessService.decide({
      projectCode: target.projectCode,
      prototypeCode: target.prototypeCode,
      // C4：只从 Cookie 头取凭据。`readCookie` 由服务层按名字要，服务层不知道传输层长什么样。
      readCookie: (name) => this.cookies.read(request, name),
    });

    if (outcome.decision.status === 200) {
      const releaseDir = this.releaseDir(outcome);
      if (releaseDir === null) {
        // 决策说放行却没有目录：本层造不出这种不一致，真出现就是数据与决策对不上。
        // 收敛成 404 而不是 500——nginx 的 error_page 只认这四种状态码。
        this.recordVisit(request, target, 404, outcome);
        this.deny(reply, 404, 'NOT_FOUND');
        return;
      }
      this.recordVisit(request, target, 200, outcome);
      this.allow(reply, releaseDir);
      return;
    }

    this.recordVisit(request, target, outcome.decision.status, outcome);
    this.deny(
      reply,
      outcome.decision.status,
      outcome.decision.reason ?? 'NOT_FOUND',
    );
  }

  /**
   * 门面页（接口设计 §9.3、机制 §5.3；M4-T6）。nginx `error_page` 把它代理成 401/403/404 的正文，
   * 所以它必须：自包含 HTML（不引构建产物）、`no-store`（权限一改就要立刻重新看到）、不回显业务信息。
   *
   * 状态码固定 200：真正的状态由 nginx 那侧的 `error_page` 决定（它保留原响应的状态码），
   * 这里返回 200 是为了让"直接打开这个地址看形态"成为可能（Gate G9 就是逐形态看源码）。
   *
   * M4-T9 起它兼任**线上"资源 404"的记录点**（机制 §6 的白屏线索）：nginx 服务静态文件时，
   * 产物里缺这个文件不会产生第五种决策，而是 `error_page 404` 直接转到这里。理由见 `recordGateMiss()`。
   * 记录是 fire-and-forget：这一页的正文不能因为统计而变慢或变错。
   */
  @Public()
  @SkipEnvelope()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @Get('gate')
  @ApiOperation({ summary: '访问门面页（五种形态，自包含 HTML）', operationId: 'accessGate' })
  gate(@Req() request: TraceableRequest, @Query() query: Record<string, unknown>): string {
    const facts = parseGateQuery(query);
    void this.recordGateMiss(request, query, facts.from);
    return renderGatePage(facts, this.env.env.http.publicBaseUrl);
  }

  /**
   * 密码档解锁（接口设计 §9.2、机制 §5.2；M4-T7）。公网可达，表单来自门面页。
   *
   * 编码不合法给 **404 而不是 400**：这条 URL 与 `/p/{项目}/{原型}` 指向同一个原型，而那条链接
   * 对非法编码给的就是 404（`parseAccessUri` 返回 null）。同一个资源在两个入口给两种状态差，
   * 就又多了一条"能不能用状态码枚举编码"的缝（R-9）。
   *
   * 429 由 `UnlockRateLimiter` 抛 `BusinessException` 交全局异常过滤器出信封（与 M1 登录那条同一路）；
   * 其余四种结论都在这里落，因为状态码要随判定变，不能交给拦截器。
   */
  @Public()
  @SkipEnvelope()
  @Post(':projectCode/:prototypeCode/unlock')
  @ApiOperation({ summary: '访问密码解锁（下发原型级 HttpOnly Cookie）', operationId: 'accessUnlock' })
  async unlock(
    @Req() request: TraceableRequest,
    @Res() reply: HttpReplyLike,
    @Param('projectCode') projectCode: string,
    @Param('prototypeCode') prototypeCode: string,
    @Body() body: unknown,
  ): Promise<void> {
    const password = parseUnlockBody(body);
    if (!isValidProjectCode(projectCode) || !isValidPrototypeCode(prototypeCode)) {
      this.deny(reply, 404, 'NOT_FOUND');
      return;
    }
    this.respondUnlock(
      reply,
      await this.unlockService.unlock({
        // 计数与锁按来源 IP，取的是 `clientIpOf` 那一串回落（X-Real-IP → XFF → socket），
        // 与登录日志同一个来源，两处不会算出两个"谁在试"。
        ip: clientIpOf(request),
        password,
        projectCode,
        prototypeCode,
      }),
    );
  }

  private respondUnlock(reply: HttpReplyLike, result: UnlockResult): void {
    if (result.kind === 'unlocked') {
      setResponseHeader(
        reply,
        'set-cookie',
        this.cookies.serialize(result.cookieName, result.cookieValue, {
          maxAgeSeconds: result.maxAgeSeconds,
          path: result.cookiePath,
        }),
      );
    }
    if (result.kind === 'unlocked' || result.kind === 'already-open') {
      reply.status(200);
      reply.send(toSuccessEnvelope(null));
      return;
    }
    if (result.kind === 'bad-password') {
      reply.status(403);
      reply.send(
        toErrorEnvelope({
          errorCode: ERROR_CODES.ACCESS_BAD_PASSWORD,
          // 不提"还剩几次"也不提"锁到几点"：这两句话对真客户没用（他只知道下一步该重试），
          // 对爆破者却是免费的进度反馈。锁住的回答由 429 那条给。
          message: '访问密码不对，请再试一次',
        }),
      );
      return;
    }
    this.deny(reply, result.status, result.reason);
  }

  /**
   * 访问决策那一次的记录（机制 §6；M4-T9）。
   *
   * 这里负责两类行：**入口文档的成功**（`ok`——"有人访问了这个原型"的唯一真实信号）与
   * **所有被拒**（`denied_401`/`denied_403`/`not_found`）。资源请求的 200 由 `record-policy.ts`
   * 挡掉：一个原型 40 个资源，全记会让 PV 虚高 40 倍。
   *
   * 唯一的例外是**非入口的 404**：线上那一跳 nginx 会接着转到 `/api/access/gate`，由那里记
   * （见 `recordGateMiss()`），两处都记就成了同一次访问两条 `not_found`。本地直出没有这一跳
   * （门面页在服务层内联渲染），那条记录由直出路由自己出——两个记录点不同，但共用同一个
   * `accessLogResultOf()`，所以"记哪几类"这件事只有一份实现。
   */
  private recordVisit(
    request: TraceableRequest,
    target: AccessTarget,
    status: number,
    outcome: AccessOutcome,
  ): void {
    const isEntry = isEntryDocument(target);
    if (status === 404 && !isEntry) {
      return;
    }
    this.accessLog.record({
      isEntry,
      projectCode: target.projectCode,
      prototypeCode: target.prototypeCode,
      prototypeId: outcome.prototypeId,
      releaseId: outcome.decision.releaseId,
      request,
      status,
      // 原始 URI（nginx 用 `$request_uri` 填）；recorder 只取 `?` 之前的路径入库。
      uri: readRequestHeader(request, ORIGINAL_URI_HEADER) ?? '',
      userId: outcome.sessionUserId,
    });
  }

  /**
   * 线上"发布产物里缺这个文件"的记录点（机制 §6 表的最后一行：非入口资源请求且 404 → `not_found`，
   * 文档称它是"白屏的关键线索"）。
   *
   * 为什么只能记在这里：文件缺失是 nginx 在自己的静态处理里发现的，它唯一能告诉我们这件事的方式
   * 就是按 `error_page 404` 转到这个接口，并把原始 URI 放进 `from`。决策接口当时只知道"编码存在、
   * 凭据够"，不知道文件在不在——这条信息没有第二个来源。
   *
   * 三个过滤条件同时用来防重复计数：`code=404`（401/403 那两类 `check` 已经记过）、
   * `from` 解析得出两段编码（否则没有可归属的 `route_key`）、**且不是入口文档**
   * （入口的 404 必然是 `check` 记过的那一次：能走到静态处理器说明决策已放行，而放行过的入口
   * 只有 `index.html` 本身缺失才会 404，那种发布在 M3 的校验里就进不了库）。
   *
   * 顺手取一次原型 id：这一行是"还活着的原型缺了个文件"，不是"无效链接"。`prototype_id` 留空会让
   * 列表页把它显示成无效链接、`topPrototypes` 也少一项（§6.1）。查不到就留空——统计不完整
   * 好过让门面页出错，所以整条链路是 fire-and-forget，失败只吞掉这一行。
   */
  private async recordGateMiss(
    request: TraceableRequest,
    query: Record<string, unknown>,
    from: string | null,
  ): Promise<void> {
    if (query.code !== '404' || from === null) {
      return;
    }
    const target = parseAccessUri(from);
    if (target === null || isEntryDocument(target)) {
      return;
    }
    const rows = await this.accessRepo
      .findRowsByCodes(target.projectCode, target.prototypeCode)
      .catch(() => null);
    this.accessLog.record({
      isEntry: false,
      projectCode: target.projectCode,
      prototypeCode: target.prototypeCode,
      prototypeId: rows?.prototype?.id ?? null,
      releaseId: rows?.prototype?.currentReleaseId ?? null,
      request,
      status: 404,
      uri: from,
    });
  }

  /**
   * 200 的版本目录；三个 id 有一个缺就说明决策与取行不一致，交调用方收敛成 404。
   */
  private releaseDir(outcome: AccessOutcome): string | null {
    const releaseId = outcome.decision.releaseId;
    if (
      outcome.projectId === null ||
      outcome.prototypeId === null ||
      releaseId === undefined
    ) {
      return null;
    }
    return releaseKey(outcome.projectId, outcome.prototypeId, releaseId);
  }

  private allow(reply: HttpReplyLike, releaseDir: string): void {
    // C1
    setResponseHeader(reply, PROTO_RELEASE_DIR_HEADER, releaseDir);
    reply.status(200);
    reply.send(
      toSuccessEnvelope({
        // §9.1：响应体对 nginx 无意义，只为人肉排障留一个 `reason`。
        reason: null,
        releaseDir,
      }),
    );
  }

  /**
   * `errorCode` 默认就是原因码本身：这七个值（§9.1）本来就是给机器看的稳定标识，
   * 再造一套 `ACCESS_*` 只是同一信息的第二个名字。
   */
  private deny(
    reply: HttpReplyLike,
    status: 401 | 403 | 404,
    reason: DenyReason,
    errorCode: string = reason,
  ): void {
    // C2
    setResponseHeader(reply, PROTO_REASON_HEADER, reason);
    reply.status(status);
    reply.send(
      toErrorEnvelope({
        errorCode,
        // 不回显任何业务信息（项目名/原型名/谁在旁边看），门面页与访问日志同口径（M4-T6/G9）
        message: '访问未通过',
      }),
    );
  }
}

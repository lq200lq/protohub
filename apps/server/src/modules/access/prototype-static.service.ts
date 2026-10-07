import { stat } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { AccessReason } from '@protohub/shared';

import { CookieService } from '../../common/permission/cookie.service';
import { readRequestHeader, type HttpRequestLike } from '../../common/http-types';
import { AppEnvService } from '../../config/app-env.service';
import {
  requireLocalPath,
  STORAGE_ADAPTER,
  type StorageAdapter,
} from '../storage/storage.adapter';
import { releaseFileKey } from '../storage/storage-keys';
import { type AccessTarget, isEntryDocument, parseAccessUri } from './access-uri';
import { AccessService, type AccessOutcome } from './access.service';
import { parseGateQuery, renderGatePage } from './gate-page';
import { contentTypeOf, isHtmlUri } from './static-mime';

/**
 * Node 直出静态产物（`SERVE_STATIC=node`；[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md)
 * §5、§7；[部署与运维方案.md](../../../../../docs/部署与运维方案.md) §5 的 nginx 段；迭代实施计划 M4-T4/T5）。
 *
 * 生产由 nginx 直出，Node 只答一次 `auth_request`；开发没有 nginx，于是这条路由把 nginx 做的四件事
 * 在原进程里做一遍：**决策 → 定位版本目录 → 缓存头 → 点文件拒绝**。之所以值得手写而不是"开发期随便发发"：
 * 决策 D-05 要的是"本地能开、线上也拦"，而两边只有共用同一个 `AccessService.decide()` 才可能同口径；
 * 缓存头与点文件这两条则是 Gate G7 的判据（`curl -I`），差异会直接变成"F-8：HTML 被缓存"。
 *
 * 与 nginx 逐条对齐的地方都标了出处，任何一条改动都必须回去核对部署方案 §5 的那段配置。
 */

/** 目录默认文档（nginx `index index.html`）。 */
const ENTRY_DOCUMENT = 'index.html';

/** 请求侧只用到 `url` 与 `headers`，与 `HttpRequestLike` 同形；`url` 是含查询串的原始 URI（≈ nginx 的 `$request_uri`）。 */
export interface StaticRequest extends HttpRequestLike {
  readonly url: string;
}

/**
 * 这一次访问的可记事实（M4-T9；写库前还要过 `record-policy.ts` 那张表）。
 *
 * 与 `/api/access/check` 那边给 recorder 的是同一组输入：两级编码 + 决策算出来的三个 id。
 * 直出入口比 nginx 多知道一件事——文件到底在不在（它会 `stat()`），所以"产物里缺这个文件"
 * 这一类 404 在这里能直接记，线上那一跳只能由 `/api/access/gate` 记（见控制器的注释）。
 */
export interface VisitFacts {
  readonly isEntry: boolean;
  readonly projectCode: string;
  readonly prototypeCode: string;
  readonly prototypeId: string | null;
  readonly releaseId: string | null;
  readonly userId: string | null;
}

/**
 * 一次直出的结论。刻意做成**数据而不是副作用**：`filePath` 由传输层拿去流式发送，
 * 于是缓存头、304、点文件、门面页这些判定都能在单测里逐条对上（Gate G7 要 `curl -I` 核对的每一条）。
 * `access` 同理——服务层只把"该记什么"算出来，真正写不写库由传输层交给 recorder 判。
 */
export interface StaticResponse {
  readonly access?: VisitFacts;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly body?: string;
  readonly filePath?: string;
}

/** 拼出版本目录需要的三个 id（决策放行时必带，缺任何一个都按"没有产物"处理）。 */
interface ReleaseIds {
  readonly projectId: string;
  readonly prototypeId: string;
  readonly releaseId: string;
}

function pathPartOf(uri: string): string {
  return uri.split('?')[0] ?? uri;
}

function queryPartOf(uri: string): string {
  const index = uri.indexOf('?');
  return index === -1 ? '' : uri.slice(index);
}

/**
 * 产物内相对路径（机制 §1.2 的 key 尾段）。
 *
 * 目录写法落到默认文档：根目录（`/p/crm/crm-p01/`）与子目录（`/p/crm/crm-p01/pages/`）都是
 * `index.html`，与 nginx 的 `index index.html` 同一条。尾斜杠由调用方从**原始 URI** 上判断——
 * `parseAccessUri()` 会把末尾的空段吃掉，归一之后这里再也看不出来"原本是个目录"。
 */
function relativeDocumentOf(resourcePath: string, isDirectory: boolean): string {
  const trimmed = resourcePath.replace(/^\//, '');
  if (trimmed === '') {
    return ENTRY_DOCUMENT;
  }
  return isDirectory ? `${trimmed}/${ENTRY_DOCUMENT}` : trimmed;
}

/**
 * 点文件判定（§7 表第三行"deny"；nginx 侧是 `location ~ /\.`）。
 *
 * 输入是 `resolveResourcePath()` 归一过的路径：那一步已经把 `.`/`..` 消掉，所以这里剩下的
 * 以点开头的段就是真正的点文件（`.env`、`.git/config`），不会被"穿越"和"点文件"混成一条。
 */
function hasDotSegment(resourcePath: string): boolean {
  return resourcePath.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * `parseAccessUri()` 给的 `resourcePath` 是**原始**（未解码）的 URI 尾段，直接拿去查文件会和
 * nginx 给出不同答案，而决策 D-05 要防的正是这个：`my%20page.html` 线上能开、本地 404；
 * `%2Eenv` 线上被点文件规则拒成 403、本地却当成一个叫 `%2Eenv` 的文件去找。
 *
 * 于是在这里补做 nginx 在匹配 location **之前**就做完的两件事——百分号解码与 `.`/`..` 归一
 * （`merge_slashes` 也是同一批规范化）。解码后带出的 `/` 因此会被当成段分隔，与 nginx 一致。
 *
 * 返回 `null` 表示这个请求根本落不到版本目录里（`%ZZ` 这种畸形转义、`/x/../../etc` 这种越界穿越）：
 * 交调用方按 404 处理——nginx 对后者会把 URI 归一成 `/etc/passwd`，那条链接压根不在 `/p/` 下。
 */
function resolveResourcePath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      // 段数不够可退就是在往版本目录外面走，没有"半个目录"这种中间态
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

/** 强 ETag：大小 + mtime（毫秒截断），与 nginx 的 `W/"size-mtime"` 同源但可强比较。 */
function etagOf(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
}

/**
 * 决策结果 → 这一次访问的可记事实（M4-T9）。
 *
 * `isEntry` 用的是 `access-uri.ts` 里那一份判定，与 `/api/access/check` 记日志时同一个函数，
 * 所以"什么算一次访问"这件事在两个入口不会各自长出一套（决策 D-05 的另一面）。
 */
function factsOf(target: AccessTarget, outcome: AccessOutcome): VisitFacts {
  return {
    isEntry: isEntryDocument(target),
    projectCode: target.projectCode,
    prototypeCode: target.prototypeCode,
    prototypeId: outcome.prototypeId,
    releaseId: outcome.decision.releaseId ?? null,
    userId: outcome.sessionUserId,
  };
}

/** `If-None-Match` 的实体标签列表（可能是 `*`、单个、或以逗号分隔的多个；`W/` 前缀参与比较时去掉）。 */
function noneMatchMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const target = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((item) => item.trim().replace(/^W\//, ''))
    .some((item) => item === '*' || item === target);
}

/**
 * `If-Modified-Since` 按秒比较（HTTP-date 只有秒精度，`mtime` 向下取整才算"同一秒内没变"）。
 * 解析失败（畸形日期）当作没有这个头：宁可多发一份 body，也不要把新内容 304 掉。
 */
function modifiedSinceMatches(header: string | undefined, mtimeMs: number): boolean {
  if (header === undefined) {
    return false;
  }
  const since = Date.parse(header);
  if (Number.isNaN(since)) {
    return false;
  }
  return Math.trunc(mtimeMs / 1000) <= Math.trunc(since / 1000);
}

@Injectable()
export class PrototypeStaticService {
  constructor(
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly cookies: CookieService,
    private readonly env: AppEnvService,
  ) {}

  async serve(request: StaticRequest): Promise<StaticResponse> {
    const target = parseAccessUri(request.url);
    if (target === null) {
      // 单段 `/p/crm`、畸形编码、非 `/p/` 前缀：与"编码不存在"同一个 404 门面页（G6）。
      return this.gate(404, request, undefined, undefined);
    }

    // 少一个尾斜杠 → 301。这一条必须在决策之前，与部署方案 §5 那条 `return 301` 一致：
    // 相对路径的基准是"最后一个带斜杠的段"，不跳这一步，`index.html` 里的 `assets/app.js`
    // 会被解析成 `/p/crm/assets/app.js`，用户看到的是一个白屏的"能打开"的原型。
    const path = pathPartOf(request.url);
    if (target.resourcePath === '' && !path.endsWith('/')) {
      return {
        headers: {
          'Cache-Control': 'no-store',
          Location: `${path}/${queryPartOf(request.url)}`,
        },
        status: 301,
      };
    }

    const outcome = await this.access.decide({
      projectCode: target.projectCode,
      prototypeCode: target.prototypeCode,
      readCookie: (name) => this.cookies.read(request, name),
    });

    if (outcome.decision.status !== 200) {
      return this.gate(
        outcome.decision.status,
        request,
        target,
        outcome.decision.reason ?? 'NOT_FOUND',
        factsOf(target, outcome),
      );
    }

    const located = this.locate(outcome);
    if (located === null) {
      // 决策说放行却没有三个 id：与 `/api/access/check` 同一处收敛成 404，不出现第五种状态码。
      return this.gate(404, request, target, 'NOT_FOUND', factsOf(target, outcome));
    }
    const { projectId, prototypeId, releaseId } = located;
    const facts = factsOf(target, outcome);

    // §7 第三行的点文件拒绝。位置在决策**之后**：nginx 的 `auth_request` 同样在外层 location 上，
    // 所以"要密码的原型里的点文件"两边走的都是 401 密码页，而不是提前泄露"这个路径确实存在"。
    const resolved = resolveResourcePath(target.resourcePath);
    if (resolved === null) {
      return this.gate(404, request, target, 'NOT_FOUND', facts);
    }
    if (hasDotSegment(resolved)) {
      return this.gate(403, request, target, undefined, facts);
    }

    const relative = relativeDocumentOf(resolved, path.endsWith('/'));
    let absPath: string;
    try {
      absPath = requireLocalPath(
        this.storage,
        releaseFileKey(projectId, prototypeId, releaseId, relative),
      );
    } catch {
      // `releaseFileKey()` 的路径初查（`..`、绝对路径、空段、超长）在这里撞上就是畸形请求：
      // 与"文件不存在"同一个 404，不给第五种状态码。
      return this.gate(404, request, target, 'NOT_FOUND', facts);
    }

    const info = await stat(absPath).catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return null;
      }
      // 其余（权限、IO 故障）不是"没有这个文件"，交给传输层报 500 并留日志：
      // 把它翻成 404 会让"磁盘坏了"看起来像"原型被删了"。
      throw error;
    });
    if (info === null) {
      return this.gate(404, request, target, 'NOT_FOUND', facts);
    }
    if (!info.isFile()) {
      // 目录（不带尾斜杠）与设备文件之类：nginx 在这里给 403（`ngx_http_static_handler` 对目录
      // 返回 FORBIDDEN），走 `error_page 403` → 门面页的兜底形态。
      return this.gate(403, request, target, undefined, facts);
    }

    const cacheControl = isHtmlUri(request.url) ? 'no-store' : 'no-cache';
    const etag = etagOf(info.size, info.mtimeMs);
    const lastModified = info.mtime.toUTCString();
    const conditional =
      noneMatchMatches(readRequestHeader(request, 'if-none-match'), etag) ||
      modifiedSinceMatches(readRequestHeader(request, 'if-modified-since'), info.mtimeMs);
    if (conditional) {
      // 304 不带 body，也就不能带 Content-Length/Content-Type（RFC 9110 §15.4.5）。
      return {
        headers: { 'Cache-Control': cacheControl, ETag: etag, 'Last-Modified': lastModified },
        status: 304,
      };
    }

    return {
      access: facts,
      filePath: absPath,
      headers: {
        'Cache-Control': cacheControl,
        'Content-Length': String(info.size),
        'Content-Type': contentTypeOf(relative),
        ETag: etag,
        'Last-Modified': lastModified,
        // 类型只由扩展名给（不猜内容），这一条把"浏览器改名嗅探"这条路堵上
        'X-Content-Type-Options': 'nosniff',
      },
      status: 200,
    };
  }

  /** 决策给的三个 id 是否够拼出版本目录（与 `access.controller.ts` 的 `releaseDir()` 同一个判断）。 */
  private locate(outcome: AccessOutcome): ReleaseIds | null {
    const releaseId = outcome.decision.releaseId;
    if (
      outcome.projectId === null ||
      outcome.prototypeId === null ||
      releaseId === undefined
    ) {
      return null;
    }
    return { projectId: outcome.projectId, prototypeId: outcome.prototypeId, releaseId };
  }

  /**
   * 门面页（§5.3）。这里**不自己拼 HTML**，而是把 `code/reason/project/prototype/from` 交给
   * `parseGateQuery()` 再渲染——与 nginx `error_page` 打给 `/api/access/gate` 的那串查询参数
   * 逐字同形，所以"本地直出看到的页面"和"线上 nginx 拦下来的页面"是同一份代码算出来的（D-05）。
   *
   * 状态码用决策的那一个：直出入口没有 nginx 的 `error_page`，页面与状态码必须由这里一起给对
   * （G5 判据：403 的 NEED_LOGIN 门面页）。
   */
  private gate(
    status: 401 | 403 | 404,
    request: StaticRequest,
    target: AccessTarget | undefined,
    reason: AccessReason | undefined,
    facts?: VisitFacts,
  ): StaticResponse {
    const html = renderGatePage(
      parseGateQuery({
        code: String(status),
        from: request.url,
        project: target?.projectCode ?? '',
        prototype: target?.prototypeCode ?? '',
        reason: reason ?? '',
      }),
      this.env.env.http.publicBaseUrl,
    );
    return {
      access: facts,
      body: html,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      },
      status,
    };
  }
}

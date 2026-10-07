import { createReadStream } from 'node:fs';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { AppEnvService } from '../../config/app-env.service';
import { AccessLogRecorderService } from '../accesslog/access-log.recorder.service';
import { PrototypeStaticService, type StaticRequest } from './prototype-static.service';

/**
 * 直出路由的传输层（迭代实施计划 M4-T4 的交付物外壳；判定全在 `PrototypeStaticService`）。
 *
 * 为什么不走 Nest 控制器：`/p/...` **不是 API**。它必须在 `api` 全局前缀之外（nginx 的
 * `location ^~ /p/` 同样在 `/api/` 之外）、不套响应信封、不经鉴权守卫（凭据判定由 `decideAccess`
 * 自己做，与 `/api/access/check` 同一份），并且要能直接发流与发 304。这四条里任意一条都要在控制器
 * 上开一个例外，而它们的合集正好就是"注册一条原生 Fastify 路由"。
 *
 * `HttpAdapterHost` 拿到的是适配器包着的原生实例；`onApplicationBootstrap` 是 Nest 自己
 * 注册完全部控制器**之后**、`listen()` 之前的最后一个钩子，所以这条路由不会和 `/api/*` 抢前缀，
 * 也不会在实例 ready 之后才出现（那时 Fastify 拒绝新增路由）。
 */

/** 只声明用到的那几个方法：`fastify` 不是本包依赖（见 `common/http-types.ts` 的同一条理由）。 */
interface StaticFastifyReply {
  code(status: number): StaticFastifyReply;
  header(name: string, value: string): StaticFastifyReply;
  send(body?: unknown): StaticFastifyReply;
}

interface StaticFastifyRequest extends StaticRequest {
  readonly method: string;
}

interface StaticRouteConfig {
  /**
   * `void` 而不是 `Promise<void>`：返回 Promise 就会让 Fastify 在 resolve 之后补发一次
   * `send(undefined)`（见 `onApplicationBootstrap` 里那条实测踩坑）。类型上直接禁掉，
   * 免得以后有人把这里"顺手改成 async"。
   */
  handler: (request: StaticFastifyRequest, reply: StaticFastifyReply) => void;
  method: 'GET';
  url: string;
}

interface StaticFastifyInstance {
  route(config: StaticRouteConfig): unknown;
}

/**
 * 原型站点的 URL 形态：`/p/` 下的**全部**形状都归这条路由。
 *
 * 用通配而不是 `/p/:projectCode/:prototypeCode/*`：后者的通配段要求非空，于是
 * `/p/{项目}/{原型}`（少尾斜杠，最常见的手敲形态）和 `/p/{项目}`（单段，G6）都落不到这里，
 * 而是掉进 Nest 的默认 404 —— 那是一枚 JSON 信封，而 nginx 的 `location ^~ /p/` 前缀匹配
 * 会把这两种形状都交给我们（301 与门面页 404）。本地和线上必须给同一个页面（D-05）。
 *
 * 具体形状由 `PrototypeStaticService` 自己判（`parseAccessUri` 已经把这些情况收敛成 null/301），
 * 这里只负责把流量接进来。裸 `/p`（没有尾斜杠）不匹配：nginx 的 `^~ /p/` 同样不匹配它。
 */
const STATIC_ROUTE_URL = '/p/*';

@Injectable()
export class PrototypeStaticRoute implements OnApplicationBootstrap {
  private readonly logger = new Logger(PrototypeStaticRoute.name);

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly env: AppEnvService,
    private readonly service: PrototypeStaticService,
    private readonly accessLog: AccessLogRecorderService,
  ) {}

  onApplicationBootstrap(): void {
    // `SERVE_STATIC=nginx` 时静态流量根本不进 Node（平台设计方案 §5、部署方案 §2），
    // 连路由都不注册：留一条"生产也能直出"的路，就等于留一份与 nginx 不一致的鉴权实现。
    if (this.env.env.serveStatic !== 'node') {
      return;
    }
    const instance = this.httpAdapterHost.httpAdapter.getInstance<StaticFastifyInstance>();
    instance.route({
      // 处理器**不能是 async**：Fastify 见到 handler 返回 Promise，会在它 resolve 成
      // `undefined` 时替我们再发一次 `reply.send(undefined)`（`lib/wrap-thenable.js`），
      // 而那条路径会把 `content-length` 写成 0 并立刻 flush 响应；`send(stream)` 走的是
      // `setHeader + pipe`，不把 `reply.sent` 置位，于是拦不住这第二次发送——
      // 实测结果是 200 + 正确的 ETag + 0 字节空体，原型永远打不开。
      // 同步返回 `undefined` 才让发送时机只属于 `dispatch`。
      handler: (request, reply) => {
        this.dispatch(request, reply).catch((error: unknown) => {
          this.fail(reply, error);
        });
      },
      method: 'GET',
      url: STATIC_ROUTE_URL,
    });
    // Fastify 会为每条 GET 自动派生 HEAD（`exposeHeadRoutes` 自 v4 起默认开），
    // 所以 `curl -I` 核对响应头（Gate G7）打的就是这同一条路由。
    this.logger.log('静态产物由 Node 直出（SERVE_STATIC=node）');
  }

  private async dispatch(
    request: StaticFastifyRequest,
    reply: StaticFastifyReply,
  ): Promise<void> {
    const result = await this.service.serve(request);
    // 访问记录（M4-T9）。放在发送之前：文件流打开失败、客户端中途断开都不该让这一次访问
    // 从统计里消失——入口文档已经有人请求了。`record()` 保证同步、不抛、不 await。
    if (result.access !== undefined) {
      this.accessLog.record({
        ...result.access,
        request,
        status: result.status,
        uri: request.url,
      });
    }
    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }
    reply.code(result.status);
    if (result.filePath !== undefined) {
      // 流式发送：原型产物单文件可到 100MB 级（上传上限），整包读进内存会让直出入口先把自己打挂。
      reply.send(createReadStream(result.filePath));
      return;
    }
    reply.send(result.body ?? '');
  }

  /**
   * 只有"读不了盘"才会走到这里（`ENOENT`/`ENOTDIR` 在服务层已经收敛成 404，穿越与点文件也是）。
   *
   * 这里允许 500：`/api/access/check` 那套"四种状态码"的约束是给 nginx 的 `error_page` 用的，
   * 直出入口没有 nginx 在中间；把磁盘故障伪装成"原型不存在"会让排障的人去找一个并不存在的链接。
   */
  private fail(reply: StaticFastifyReply, error: unknown): void {
    this.logger.error(`静态直出失败：${(error as Error)?.message ?? String(error)}`);
    reply.header('Cache-Control', 'no-store');
    reply.code(500).send('该原型的文件暂时读不出来');
  }
}

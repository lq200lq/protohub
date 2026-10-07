import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ERROR_CODES, type DataScope } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import type { AuthUser } from '../../../common/permission/auth-user';

/**
 * 超管角色标识（权限模型设计 §4）。
 * 字面值复制而不是 import：`SUPER_ADMIN_ROLE` 定义在 common/permission/account.service.ts，
 * 那个文件顶层有 `import { prisma } from '@protohub/db'` 的**值**导入（当前在 CJS 服务端里加载即抛），
 * 常量本身无歧义、也无必要把整个 service 的模块图拖进 system 模块。
 */
export const SUPER_ADMIN_ROLE_CODE = 'super_admin';

/**
 * 系统管理接口的"操作者"视图：由 AuthGuard 写在 `request.user` 上的登录态收敛而来。
 *
 * 为什么不直接各处读 `request.user`：本模块的每条约束（C-2/C-3/C-4）与每一条审计记录都要用到
 * "我是谁"，把取值与"没有登录态就是编程错误"的判定收敛在一处，服务层就能拿到一个非空类型。
 */
export interface Actor {
  readonly userId: string;
  readonly username: string;
  /** 角色 code 列表，供 C-4（谁能授 super_admin）与 C-3（不能撤自己的超管）判定。 */
  readonly roles: readonly string[];
  /** 是否超管（权限模型 §4 C-5 的短路身份）。 */
  readonly isSuperAdmin: boolean;
  /** 多角色里最宽的数据范围（权限模型 §6.1）；业务模块的范围过滤从这里取。 */
  readonly dataScope: DataScope;
}

/** 请求对象上本模块关心的部分；与 common/permission/auth-user.ts 的 RequestWithUser 同形。 */
export interface SystemRequest {
  readonly user?: AuthUser;
  readonly method?: string;
  readonly url?: string;
  readonly ip?: string;
  readonly headers?: Record<string, unknown>;
}

export function toActor(user: AuthUser): Actor {
  return {
    userId: user.userId,
    username: user.username,
    roles: user.roles,
    isSuperAdmin: user.roles.includes(SUPER_ADMIN_ROLE_CODE),
    dataScope: user.dataScope,
  };
}

/**
 * 从执行上下文取操作者；拿不到就抛 401。
 *
 * 401 而非 403：`request.user` 缺失只可能是"根本没登录/令牌失效"（权限模型 §5.2 的状态码语义）。
 * 全局 AuthGuard 正常情况下已经拦在前面，走到这里说明 Guard 没覆盖这条路由——
 * 属于配置缺陷，必须显式失败，绝不能让审计日志里出现"匿名操作者改了什么"。
 */
export function actorFromContext(context: ExecutionContext): Actor {
  const request = context.switchToHttp().getRequest<SystemRequest>();
  return actorFromRequest(request);
}

export function actorFromRequest(request: SystemRequest): Actor {
  const user = request.user;
  if (!user) {
    throw new BusinessException(
      '请先登录',
      ERROR_CODES.AUTH_UNAUTHORIZED,
      401,
    );
  }
  return toActor(user);
}

/** 控制器签名里用 `@Actor() actor: Actor` 代替手写的 `@Req()`。 */
export const ActorParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => actorFromContext(context),
);

/** 审计日志需要的请求元信息（method/path/ip），单独取，避免把整个 request 传进服务层。 */
export interface RequestMeta {
  readonly method: string | null;
  readonly path: string | null;
  readonly ip: string | null;
}

export function requestMetaFromContext(context: ExecutionContext): RequestMeta {
  const request = context.switchToHttp().getRequest<SystemRequest>();
  return {
    method: request.method ?? null,
    path: request.url ? request.url.split('?')[0] ?? null : null,
    ip: request.ip ?? null,
  };
}

export const RequestMetaParam = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestMeta =>
    requestMetaFromContext(context),
);

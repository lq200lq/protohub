import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ERROR_CODES, USER_STATUS_ENABLED } from '@protohub/shared';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorator/public.decorator';
import { readRequestHeader, type HttpRequestLike } from '../http-types';
import {
  ForbiddenBusinessException,
  UnauthorizedException,
} from '../exception/business.exception';
import { AccountService, type Account } from './account.service';
import type { AuthUser } from './auth-user';
import { JwtTokenService } from './jwt-token.service';
import { PermissionCodeService } from './permission-code.service';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';

/** 带登录态的请求视图（`user` 由本 Guard 写入）。 */
interface GuardRequest extends HttpRequestLike {
  user?: AuthUser;
}

/**
 * 无需登录的路径。
 *
 * `/api/health` 属于"M0 已交付且不允许鉴权"的探针（后端接口设计 §9.4），
 * 但 health 控制器不在本次可改动范围内，所以在这里按**精确路径**放行
 * （不用前缀：`/api/health/detail` 将来要 `system:log:list`）。
 * 新写的公开接口请直接用 `@Public()`。
 */
const PUBLIC_PATHS = new Set(['/api/health']);

function requestPath(request: HttpRequestLike): string {
  const url = request.url ?? '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * 全局鉴权守卫（权限模型设计 §8.1）。
 *
 * 状态码语义是整个前端流程的地基：**401 = 未登录/令牌无效（前端会去刷新并重放）**，
 * **403 = 已登录但权限不足（前端只提示，不刷新）**。写反会让用户被反复踢回登录页。
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: JwtTokenService,
    private readonly accounts: AccountService,
    private readonly permissionCodes: PermissionCodeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    if (this.isPublic(context, request)) {
      return true;
    }

    const token = this.tokens.readBearer(
      readRequestHeader(request, 'authorization'),
    );
    if (!token) {
      throw new UnauthorizedException(
        '请先登录',
        ERROR_CODES.AUTH_UNAUTHORIZED,
      );
    }
    // 下面三步都是 401：令牌无效 / 用户不存在或被禁用 / token_version 对不上（改密撤销）。
    const payload = this.tokens.verifyAccessToken(token);
    const account = await this.requireActiveAccount(payload.sub, payload.tv);

    request.user = this.accounts.toAuthUser(account);

    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) {
      // 未标注 = 仅需登录（§8.1 的约定）。
      return true;
    }
    if (account.superAdmin) {
      // C-5：超管短路，不查权限码表。
      return true;
    }
    const owned = await this.permissionCodes.codesOfUser(account.userId);
    if (required.some((code) => owned.has(code))) {
      // OR 语义：满足任一即可。
      return true;
    }
    throw new ForbiddenBusinessException(
      `缺少权限：${required.join(' 或 ')}`,
      ERROR_CODES.AUTH_FORBIDDEN,
    );
  }

  private isPublic(context: ExecutionContext, request: HttpRequestLike): boolean {
    const marked = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (marked === true) {
      return true;
    }
    return PUBLIC_PATHS.has(requestPath(request));
  }

  private async requireActiveAccount(
    userId: string,
    tokenVersion: number,
  ): Promise<Account> {
    const account = await this.accounts.loadById(userId);
    if (!account) {
      throw new UnauthorizedException(
        '登录状态已失效，请重新登录',
        ERROR_CODES.AUTH_TOKEN_INVALID,
      );
    }
    if (account.status !== USER_STATUS_ENABLED) {
      throw new UnauthorizedException('账号已被停用', ERROR_CODES.AUTH_DISABLED);
    }
    if (account.tokenVersion !== tokenVersion) {
      // 改密/被管理员重置后，旧 accessToken 与旧 proto_sess 一起作废（§5.4）。
      throw new UnauthorizedException(
        '登录状态已更新，请重新登录',
        ERROR_CODES.AUTH_TOKEN_INVALID,
      );
    }
    return account;
  }
}

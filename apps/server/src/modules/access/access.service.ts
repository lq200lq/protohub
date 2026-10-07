import { Injectable } from '@nestjs/common';
import { USER_STATUS_ENABLED } from '@protohub/shared';

import { AccountService, type Account } from '../../common/permission/account.service';
import {
  accessCookieName,
  SESSION_COOKIE_NAME,
} from '../../common/permission/cookie.service';
import { SessionService } from '../../common/permission/session.service';
import { toActorScope } from '../../common/data-scope';
import { ProjectRepo } from '../project/project.repo';
import { AccessRepo, type AccessRows } from './access.repo';
import { decideAccess, type AccessDecision } from './decide-access';
import { UnlockTokenService } from './unlock-token.service';

/**
 * 访问决策服务（机制 §5.1 的调用方；迭代实施计划 M4-T2）。
 *
 * `decideAccess` 是纯函数，这个服务负责把它的输入**按需**算出来：
 * 先不读任何 Cookie 判一遍，只有判出来的原因是"要凭据"时才去验签、查用户表、比数据范围。
 * 于是（机制 §7.1「这个接口每个静态资源请求都会被调用一次」）：
 * - `public` 档：一次取行查询 + 一次纯函数，**不验签、不查库**；
 * - 不存在 / 已归档 / 未发布：同样不碰凭据（这些结论与身份无关）；
 * - `password` 档：只做一次 HMAC 验签；
 * - `member` 档：才走 `proto_sess` 验签 → 用户表 → 项目范围。
 *
 * 两个入口（nginx `auth_request` 打到 `/api/access/check`、本地 `SERVE_STATIC=node` 直出）
 * 都调这里，所以"本地能开、线上拦"没有存在余地（决策 D-05）。
 */

/** 输入刻意只要一个 `readCookie`：传输层（Fastify 请求 / 直出中间件）不进服务层。 */
export interface AccessQuery {
  readonly projectCode: string;
  readonly prototypeCode: string;
  readonly readCookie: (name: string) => string | undefined;
}

export interface AccessOutcome {
  readonly decision: AccessDecision;
  /** 三个 id 供响应头 `X-Proto-Release-Dir`（`releases/{p}/{q}/{r}`）与访问日志用；查不到行时为 null。 */
  readonly projectId: string | null;
  readonly prototypeId: string | null;
  /**
   * member 档判定出来的登录用户 id，供访问日志的 `user_id`。
   * 只在确实需要凭据时才算（公开/密码档的访问记不到访问者，与接口设计 §6.1 的
   * 「visitorName：member 档已登录时才有」一致；被禁用或 `token_version` 对不上同样为 null）。
   */
  readonly sessionUserId: string | null;
}

/** 判"这一遍不需要凭据"用的空凭据：三个字段同时为假，public 档照样能走到 200。 */
const NO_CREDENTIALS = {
  projectVisible: false,
  sessionUserId: null,
  unlocked: false,
} as const;

/** 第一遍可能给出的"要凭据"原因（其余原因都与身份无关，直接返回）。 */
const CREDENTIAL_REASONS = ['NEED_LOGIN', 'NEED_PASSWORD'] as const;

@Injectable()
export class AccessService {
  constructor(
    private readonly accessRepo: AccessRepo,
    private readonly projectRepo: ProjectRepo,
    private readonly accounts: AccountService,
    private readonly sessions: SessionService,
    private readonly unlockTokens: UnlockTokenService,
  ) {}

  async decide(query: AccessQuery): Promise<AccessOutcome> {
    const rows = await this.accessRepo.findRowsByCodes(
      query.projectCode,
      query.prototypeCode,
    );

    const first = decideAccess({ ...rows, ...NO_CREDENTIALS });
    if (!(CREDENTIAL_REASONS as readonly string[]).includes(first.reason ?? '')) {
      return this.outcome(first, rows, null);
    }

    if (first.reason === 'NEED_PASSWORD') {
      return this.outcome(
        decideAccess({
          ...rows,
          ...NO_CREDENTIALS,
          unlocked: this.isUnlocked(query, rows),
        }),
        rows,
        null,
      );
    }

    const session = await this.resolveSession(query, rows);
    return this.outcome(
      decideAccess({ ...rows, ...NO_CREDENTIALS, ...session }),
      rows,
      session.sessionUserId,
    );
  }

  /**
   * 解锁 Cookie 验签（机制 §5.2）：签名原文绑定了**两级编码 + 该原型的 `policy_version`**，
   * 所以既不能把 A 原型的 Cookie 挪到 B 原型上用，也会在改密码/改模式后被立即作废（D-07）。
   */
  private isUnlocked(query: AccessQuery, rows: AccessRows): boolean {
    const prototype = rows.prototype;
    if (prototype === null) {
      return false;
    }
    return this.unlockTokens.verify(
      query.readCookie(accessCookieName(prototype.id)),
      {
        policyVersion: prototype.policyVersion,
        projectCode: query.projectCode,
        prototypeCode: query.prototypeCode,
      },
    );
  }

  /**
   * member 档的身份判定（机制 §5.4：只认 `proto_sess`，读 `Authorization` 必然全员被拦）。
   *
   * Cookie 验签失败/过期、用户不存在或已停用、`token_version` 与载荷不等（改密/被重置后
   * 旧 Cookie 立刻失效，权限模型 §5.4）——三种情况都当作"未登录"，于是给出 `NEED_LOGIN`；
   * 登录成功但项目不在他的数据范围里才是 `NO_PERMISSION`。这两个原因在界面上是不同的门面页，
   * 所以不能把"看不见"折叠成"没登录"。
   */
  private async resolveSession(
    query: AccessQuery,
    rows: AccessRows,
  ): Promise<{ projectVisible: boolean; sessionUserId: string | null }> {
    const claims = this.sessions.verify(query.readCookie(SESSION_COOKIE_NAME));
    const project = rows.project;
    if (claims === null || project === null) {
      return { projectVisible: false, sessionUserId: null };
    }
    const account = await this.accounts.loadById(claims.userId);
    if (!this.isUsableAccount(account, claims.tokenVersion)) {
      return { projectVisible: false, sessionUserId: null };
    }
    // 范围停在项目层：能看到项目就能看到它下面所有原型（权限模型 §6.2），
    // 用的还是列表/详情那一份 `projectScopeWhere`，所以不会出现"列表看得见、访问链接被拦"。
    const visible = await this.projectRepo.findInScope(
      BigInt(project.id),
      toActorScope(account),
    );
    return { projectVisible: visible !== null, sessionUserId: account.userId };
  }

  private isUsableAccount(account: Account | null, tokenVersion: number): account is Account {
    return (
      account !== null &&
      account.status === USER_STATUS_ENABLED &&
      account.tokenVersion === tokenVersion
    );
  }

  private outcome(
    decision: AccessDecision,
    rows: AccessRows,
    sessionUserId: string | null,
  ): AccessOutcome {
    return {
      decision,
      projectId: rows.project?.id ?? null,
      prototypeId: rows.prototype?.id ?? null,
      sessionUserId,
    };
  }
}

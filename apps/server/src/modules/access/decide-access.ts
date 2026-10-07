/**
 * 访问决策的唯一口径（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5.1，
 * 决策 D-05/D-06/D-07；迭代实施计划 M4-T1）。
 *
 * 生产环境（nginx `auth_request` → `/api/access/check`）与本地开发（`SERVE_STATIC=node` 的
 * 静态直出）**必须调用同一个函数**，否则"本地能开、线上拦"或反之这类差异会长期存在。
 *
 * 它是纯函数：输入只有**已经查好的行**与**已经算好的判定结果**，不查库、不读 Cookie、不碰密钥。
 * §5.1 的伪代码里 `verifyUnlockToken(...)` 与 `isProjectVisibleTo(...)` 写在函数体内，
 * 这里把它们上提到调用方（`AccessService`）——原因有两条：
 *  1. 验签要用 `ACCESS_TOKEN_SECRET`、可见性要查库，留在函数体里就没法穷举单测（M4-T1 判据）；
 *  2. `/p/...` 直出与 `/api/access/check` 两个入口都要算这两样，算在两处就会漂。
 * 判定顺序与状态码语义仍逐字对齐 §5.1。
 */

import type { AccessMode, AccessReason, PrototypeStatus } from '@protohub/shared';

// 原因码与档位直接复用 `@protohub/shared`（接口设计 §9.1 的 `X-Proto-Reason` 表、
// 数据库设计 §4.2.2 的 `access_mode`），这里不再抄一份联合类型：抄来的两份早晚漂，
// 而门面页（M4-T6）与访问日志（M4-T9）消费的是同一批字面量。
export type { AccessMode, AccessReason };

/** `proto_project` 里决策要看的那几列（其余列不进来看一眼就说明用错了行类型）。 */
export interface AccessProjectRow {
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly id: string;
}

/** `proto_prototype` 里决策要看的那几列。 */
export interface AccessPrototypeRow {
  readonly accessMode: AccessMode;
  readonly currentReleaseId: string | null;
  readonly deletedAt: Date | null;
  readonly id: string;
  readonly status: PrototypeStatus;
}

export interface AccessDecisionInput {
  /** 项目行：按编码查不到（含软删）传 `null` */
  readonly project: AccessProjectRow | null;
  /**
   * 登录用户是否看得见这个项目：由调用方用 M2 的 `ProjectRepo.findAccessible`
   * （同一套 `projectScopeWhere`）算出来，权限模型 §6.2「范围停在项目层」。
   * 没有登录态时传 `false`，它只在 member 档参与判定。
   */
  readonly projectVisible: boolean;
  /** 原型行：按 `(项目, 编码)` 唯一索引查不到传 `null` */
  readonly prototype: AccessPrototypeRow | null;
  /** `proto_sess` 验签出来的用户 id；未登录是 `null`（机制 §5.4：只认 Cookie，不认 Authorization） */
  readonly sessionUserId: string | null;
  /** 该原型的 `proto_access_p{id}` 解锁 Cookie 验签结果（机制 §5.2），只在 password 档参与判定 */
  readonly unlocked: boolean;
}

export interface AccessDecision {
  /** 401 只表示"需要访问密码"；403 = 需登录/无权限/已下架；404 = 不存在或未发布（§5.1 语义） */
  readonly releaseId?: string;
  readonly reason?: AccessReason;
  readonly status: 200 | 401 | 403 | 404;
}

export function decideAccess(input: AccessDecisionInput): AccessDecision {
  const { project, projectVisible, prototype, sessionUserId, unlocked } = input;

  // ① 任一层不存在 → 统一 404：不区分"不存在"与"未发布"，避免这条链接变成编码枚举器（R-9）
  if (
    !project ||
    project.deletedAt ||
    !prototype ||
    prototype.deletedAt
  ) {
    return { reason: 'NOT_FOUND', status: 404 };
  }

  // ② 项目归档 → 其下所有原型都不可访问（M2-T11 的派生状态口径：archived 压过 published）
  if (project.archivedAt) {
    return { reason: 'PROJECT_ARCHIVED', status: 403 };
  }

  // ③ 原型自己下架
  if (prototype.status === 'archived') {
    return { reason: 'PROTOTYPE_ARCHIVED', status: 403 };
  }

  // ④ 没有生效版本：draft（从没发过）或指针被清空（版本删掉/数据不一致）
  if (prototype.status !== 'published' || !prototype.currentReleaseId) {
    return { reason: 'NOT_PUBLISHED', status: 404 };
  }

  const allow = (): AccessDecision => ({
    releaseId: prototype.currentReleaseId ?? undefined,
    status: 200,
  });

  switch (prototype.accessMode) {
    case 'member': {
      if (!sessionUserId) {
        return { reason: 'NEED_LOGIN', status: 403 };
      }
      if (!projectVisible) {
        return { reason: 'NO_PERMISSION', status: 403 };
      }
      return allow();
    }

    case 'password': {
      if (!unlocked) {
        return { reason: 'NEED_PASSWORD', status: 401 };
      }
      return allow();
    }

    case 'public': {
      return allow();
    }

    default: {
      // access_mode 在库里是 varchar，联合之外的值按**最严**处理（同 data-scope.ts 的兜底口径）：
      // 当成需要密码，而不是当成公开——宁可让用户多输一次密码，也不把原型敞给任何人。
      return { reason: 'NEED_PASSWORD', status: 401 };
    }
  }
}

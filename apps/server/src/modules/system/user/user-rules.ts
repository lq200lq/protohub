import { ERROR_CODES } from '@protohub/shared';

import {
  BusinessException,
  ForbiddenBusinessException,
} from '../../../common/exception/business.exception';
import { SUPER_ADMIN_ROLE_CODE, type Actor } from '../common/actor';

export { SUPER_ADMIN_ROLE_CODE };

/**
 * 用户相关的硬性约束（权限模型设计 §4 的 C-2/C-3/C-4）。
 *
 * 单独成文件、只吃**已经查好的布尔值与计数**，是为了让这三条能脱离数据库被逐条断言
 * （迭代实施计划 M1-T15 与"约束 C-2/C-3/C-4 逐条实测"）；查库留在 user.service.ts，规则本身是纯函数。
 *
 * 状态码选择（后端接口设计 §1.4）：
 * - C-2/C-3 是"业务规则拒绝" → 400 `USER_RULE_*`；
 * - C-4 是越权提权 → 403 `AUTH_FORBIDDEN`（只有 403 不会被前端误解成"该刷新令牌"，见 §5.2）。
 *
 * 注意：禁用自己复用 `USER_RULE_SELF_DELETE`——shared 的 error-codes 里只有 SELF_DELETE /
 * SELF_ROLE_REVOKE / LAST_SUPER_ADMIN 三个 USER_RULE_* 码，没有 SELF_DISABLE。
 * 语义同为"自锁防护"，人话文案已经区分；补码需要改 packages/shared（本次范围之外，已记入交付报告）。
 */

export function isSameUser(actor: Actor, targetUserId: string): boolean {
  return actor.userId === targetUserId;
}

/** C-2：任何操作都不能让平台失去最后一个可用的超级管理员。 */
export function assertNotLastSuperAdmin(input: {
  readonly targetIsSuperAdmin: boolean;
  readonly activeSuperAdminCount: number;
  readonly action: 'delete' | 'disable';
}): void {
  if (!input.targetIsSuperAdmin || input.activeSuperAdminCount > 1) {
    return;
  }
  throw new BusinessException(
    input.action === 'delete'
      ? '不能删除最后一个超级管理员，否则平台永久失去管理入口'
      : '不能禁用最后一个超级管理员，否则平台永久失去管理入口',
    ERROR_CODES.USER_RULE_LAST_SUPER_ADMIN,
    400,
  );
}

/** C-3：不能删自己。 */
export function assertNotSelfDelete(actor: Actor, targetUserId: string): void {
  if (isSameUser(actor, targetUserId)) {
    throw new BusinessException(
      '不能删除当前登录的账号',
      ERROR_CODES.USER_RULE_SELF_DELETE,
      400,
    );
  }
}

/** C-3 的延伸：不能禁用自己（禁用后当前会话立即失效，等价于自锁，见权限模型 §5.4）。 */
export function assertNotSelfDisable(actor: Actor, targetUserId: string): void {
  if (isSameUser(actor, targetUserId)) {
    throw new BusinessException(
      '不能禁用当前登录的账号',
      ERROR_CODES.USER_RULE_SELF_DELETE,
      400,
    );
  }
}

/** C-3：不能撤销自己的 super_admin 角色。 */
export function assertNotSelfSuperAdminRevoke(input: {
  readonly targetIsSelf: boolean;
  readonly actorIsSuperAdmin: boolean;
  readonly keepsSuperAdmin: boolean;
}): void {
  if (input.targetIsSelf && input.actorIsSuperAdmin && !input.keepsSuperAdmin) {
    throw new BusinessException(
      '不能撤销自己的超级管理员角色，请改用另一个超管账号操作',
      ERROR_CODES.USER_RULE_SELF_ROLE_REVOKE,
      400,
    );
  }
}

/** C-4：非超级管理员不能把 super_admin 授给别人（防提权）。 */
export function assertCanGrantSuperAdmin(
  actor: Actor,
  grantsSuperAdmin: boolean,
): void {
  if (grantsSuperAdmin && !actor.isSuperAdmin) {
    throw new ForbiddenBusinessException(
      '只有超级管理员才能授予「超级管理员」角色',
      ERROR_CODES.AUTH_FORBIDDEN,
    );
  }
}

import type { DataScope } from '@protohub/shared';

/**
 * Guard 校验通过后挂在 `request.user` 上的登录态。
 *
 * 为什么带这么多字段：Guard 本来就要为 `token_version`/`status` 查一次库（权限模型设计 §8.2
 * 明确这两类撤销判断**不走缓存**），顺手把身份字段交给业务接口，`/user/info` 这类接口
 * 就不必为同一个用户再查第二次。
 */
export interface AuthUser {
  readonly userId: string;
  readonly username: string;
  readonly realName: string;
  readonly avatar: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  /** 角色 code 数组（vben `hasAccessByRoles` 的输入）。 */
  readonly roles: readonly string[];
  /** 该用户数据范围最宽的角色名，用于 `/user/info` 的 `desc`。 */
  readonly primaryRoleName: string | null;
  /** 多角色取最宽（约束 C-6）。 */
  readonly dataScope: DataScope;
  readonly forcePasswordChange: boolean;
  readonly tokenVersion: number;
}

/** Nest 的 request 对象上我们关心的部分。 */
export interface RequestWithUser {
  readonly user?: AuthUser;
  headers?: Record<string, unknown>;
  readonly method?: string;
  readonly url?: string;
  readonly ip?: string;
}

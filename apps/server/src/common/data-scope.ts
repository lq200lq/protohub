import type { Prisma } from '@prisma/client';
import type { DataScope } from '@protohub/shared';

/**
 * 数据权限的查询构造层（权限模型设计 §6.1/§6.2 + 计划 M2-T2）。
 *
 * 全系统只有这一处范围判定：项目列表走 `andProjectScope`（`ProjectRepo.findPaged` 内部），
 * 单条读写走 `ProjectRepo.findAccessible`（用的还是同一个 where）。
 * 原型不单独判范围——它的可见性一律通过父项目判定（§6.2），所以 prototype 侧只调
 * `ProjectRepo`，不再写第二套 if。
 */

/** 判定范围需要的最小身份：谁 + 他角色里最宽的那个 data_scope（多角色取最宽，约束 C-6）。 */
export interface ActorScope {
  readonly dataScope: DataScope;
  readonly userId: bigint;
}

/**
 * Actor（userId 是字符串，见 §1.1 的 bigint→string 约定）→ 查询层范围视图。
 * 转换只在这一处：服务层拿到的是 bigint，不会再有"字符串比 BigInt 字段"的隐性类型错。
 */
export function toActorScope(actor: {
  readonly dataScope: DataScope;
  readonly userId: string;
}): ActorScope {
  return { dataScope: actor.dataScope, userId: BigInt(actor.userId) };
}

/**
 * `all` 不加过滤；`own` 只认 created_by；`member` 是「我参与的 ∪ 我创建的」。
 * member 必须并上 created_by：权限模型 §6.1 的口径，也是"自己建的项目不该在成员表没落上前自己先看不见"。
 */
export function projectScopeWhere(scope: ActorScope): Prisma.ProtoProjectWhereInput {
  switch (scope.dataScope) {
    case 'all': {
      return {};
    }
    case 'member': {
      return {
        OR: [
          { createdBy: scope.userId },
          { members: { some: { userId: scope.userId } } },
        ],
      };
    }
    case 'own': {
      return { createdBy: scope.userId };
    }
    default: {
      // DB 里 data_scope 是 varchar，理论上能读到联合类型之外的值；按最窄处理而不是放行。
      return { createdBy: scope.userId };
    }
  }
}

/**
 * 范围条件与业务筛选条件求交。
 *
 * 为什么要单独一个函数：调用方每组 where 都要先 `deletedAt: null` 再叠范围，
 * 少叠一次就是 F-5（猜到 id 就能打开别人的详情）；把组合收在一处，漏写在类型层面可见。
 */
export function andProjectScope(
  scope: ActorScope,
  base: Prisma.ProtoProjectWhereInput,
): Prisma.ProtoProjectWhereInput {
  const scopeWhere = projectScopeWhere(scope);
  return Object.keys(scopeWhere).length === 0 ? base : { AND: [base, scopeWhere] };
}

/**
 * 原型的范围条件 = 父项目的范围条件（权限模型 §6.2「原型不单独判数据权限」）。
 *
 * 这里把它写成嵌套条件而不是先查项目再查原型：列表页一次要拿整个项目的原型，
 * 先查再查会多打一次库；而单条读写仍然走 `ProjectRepo.findAccessible`，
 * 两个入口共用 `projectScopeWhere`，所以不会出现"列表能看见、详情 403"的口径漂移。
 * `project.deletedAt` 也叠在这里：项目软删后其原型不应再被单独访问到（计划 §8 F-6）。
 */
export function andPrototypeScope(
  scope: ActorScope,
  base: Prisma.ProtoPrototypeWhereInput,
): Prisma.ProtoPrototypeWhereInput {
  const project: Prisma.ProtoProjectWhereInput = {
    deletedAt: null,
    ...projectScopeWhere(scope),
  };
  return { ...base, project };
}

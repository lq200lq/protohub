import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

import type { AccessMode } from '@protohub/shared';

import type { AccessProjectRow, AccessPrototypeRow } from './decide-access';
import { PRISMA_CLIENT } from '../system/persistence/prisma-token';

/**
 * 访问决策的取行层（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5.1、
 * [后端接口设计.md](../../../../../docs/后端接口设计.md) §9.1；迭代实施计划 M4-T2）。
 *
 * 这个查询位于**每条静态资源请求的关键路径**上（nginx 对 `auth_request` 不缓存，见机制 §7.1），
 * 所以三条约束：
 * 1. **一次查询把项目与原型 join 出来**（`project` 关系条件走 `uk_proto_project_code`，
 *    原型走 partial unique `uk_proto_prototype_code (project_id, code)`）；
 * 2. **不叠数据范围**——范围判定属于决策服务（member 档才需要），这里只按编码取事实；
 * 3. **不取任何聚合**（接口设计 §9.1「禁止在此做联表统计」）。
 */

/** 决策要用的行：在 `AccessPrototypeRow` 之上多一个 `policyVersion`（解锁令牌签名的一部分，§5.2）。 */
export interface AccessPrototypeInfo extends AccessPrototypeRow {
  readonly policyVersion: number;
}

export interface AccessRows {
  readonly project: AccessProjectRow | null;
  readonly prototype: AccessPrototypeInfo | null;
}

const NO_ROWS: AccessRows = { project: null, prototype: null };

const ACCESS_SELECT = {
  accessMode: true,
  currentReleaseId: true,
  deletedAt: true,
  id: true,
  policyVersion: true,
  project: {
    select: { archivedAt: true, deletedAt: true, id: true },
  },
  status: true,
} satisfies Prisma.ProtoPrototypeSelect;

type AccessEntity = Prisma.ProtoPrototypeGetPayload<{ select: typeof ACCESS_SELECT }>;

const UNLOCK_SELECT = {
  accessMode: true,
  id: true,
  passwordHash: true,
  policyVersion: true,
} satisfies Prisma.ProtoPrototypeSelect;

/** 解锁判定要的四个字段（见 `findUnlockRow`）。 */
export interface UnlockRow {
  readonly accessMode: AccessMode;
  readonly id: string;
  readonly passwordHash: string | null;
  readonly policyVersion: number;
}

/**
 * `access_mode` 在库里是 varchar + CHECK。越界值收敛成 **password**（要求密码），而不是像
 * `PrototypeRepo.toAccessMode` 那样收敛成 public：管理台读到越界值只是显示不准，
 * 访问链路读到越界值就是把原型敞给任何人，两边默认值必须不同向（机制 §5.1 的最严兜底）。
 */
function toAccessMode(value: string): AccessMode {
  return value === 'public' || value === 'member' ? value : 'password';
}

function toStatus(value: string): AccessPrototypeRow['status'] {
  return value === 'published' || value === 'archived' ? value : 'draft';
}

/** bigint 列按 §1.1 的约定转成字符串；`decideAccess` 与响应头都只消费字符串形态。 */
function toRows(entity: AccessEntity | null): AccessRows {
  if (!entity) {
    return NO_ROWS;
  }
  return {
    project: {
      archivedAt: entity.project.archivedAt,
      deletedAt: entity.project.deletedAt,
      id: entity.project.id.toString(),
    },
    prototype: {
      accessMode: toAccessMode(entity.accessMode),
      currentReleaseId:
        entity.currentReleaseId === null ? null : entity.currentReleaseId.toString(),
      deletedAt: entity.deletedAt,
      id: entity.id.toString(),
      policyVersion: entity.policyVersion,
      status: toStatus(entity.status),
    },
  };
}

@Injectable()
export class AccessRepo {
  constructor(@Inject(PRISMA_CLIENT) private readonly db: PrismaClient) {}

  /**
   * 按 `(项目编码, 原型编码)` 取决策要的那一行。
   *
   * `deletedAt: null` 两边都过滤：partial unique 索引只覆盖存活行，所以"存活行唯一"这件事
   * 依赖这个条件（同码的已软删原型可以有多条，不加过滤就会随机命中一条死行而把活链接判成 404）。
   * 查不到就返回两个 null——由 `decideAccess` 统一给出 404，这里不区分"项目没有"还是"原型没有"（R-9）。
   */
  async findRowsByCodes(projectCode: string, prototypeCode: string): Promise<AccessRows> {
    const entity = await this.db.protoPrototype.findFirst({
      select: ACCESS_SELECT,
      where: {
        code: prototypeCode,
        deletedAt: null,
        project: { code: projectCode, deletedAt: null },
      },
    });
    return toRows(entity);
  }

  /**
   * 解锁要的那一行：只有 ID 主键查询与 `password_hash`。
   *
   * 为什么不在 `ACCESS_SELECT` 里顺手把哈希取出来：那条查询在**每个静态资源请求**的关键路径上
   * （§7.1），而 `password_hash` 是一枚 90+ 字符的 argon2 串，验签路径永远不需要它——把它放进
   * 选择列表等于让热路径常年把一份密码哈希读进内存再扔掉。反过来，解锁这条只按 ID 取、只在有人
   * 提交密码表单时执行，多一次查询换热路径干净是划算的。
   *
   * `accessMode` 一并取回：调用方拿到的决策说"要密码"，但那一行可能在两次查询之间被改成
   * public/member（管理员正在策略抽屉里操作），此时没有哈希可验，按密码错误处理而不是 500。
   */
  async findUnlockRow(prototypeId: string): Promise<UnlockRow | null> {
    const entity = await this.db.protoPrototype.findFirst({
      select: UNLOCK_SELECT,
      where: { deletedAt: null, id: BigInt(prototypeId) },
    });
    if (!entity) {
      return null;
    }
    return {
      accessMode: toAccessMode(entity.accessMode),
      id: entity.id.toString(),
      passwordHash: entity.passwordHash,
      policyVersion: entity.policyVersion,
    };
  }
}

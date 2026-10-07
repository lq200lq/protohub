import { fail, pass, type Rule, type RuleContext } from '../types.ts';

/**
 * 规则 1（迭代实施计划 §5 M1-T16 / §3.6）：PERMISSIONS ↔ sys_permission 双向一致。
 * 常量多了码 → DB 缺行（seed 没跑或 shared 漏同步）；DB 多了码 → 常量被删（N1 的破坏点）。
 */
export const permissionCodesVsDatabase: Rule = {
  id: 'R1',
  title: 'PERMISSIONS 常量 ↔ sys_permission 双向一致',
  run(ctx: RuleContext) {
    const inConstant = ctx.permissionCodes;
    const inDb = ctx.db.permissionCodes;

    const findings = [];
    for (const code of inConstant) {
      if (!inDb.has(code)) {
        findings.push({
          message: `权限码 "${code}" 在 PERMISSIONS 常量里，但库 ${ctx.db.databaseName} 的 sys_permission 没有这一行`,
          where: 'packages/shared/src/constants/permissions.ts',
        });
      }
    }
    for (const code of inDb) {
      if (!inConstant.has(code)) {
        findings.push({
          message: `权限码 "${code}" 存在于 sys_permission，但已从 PERMISSIONS 常量删除（前端按钮与服务端 Guard 都会失去唯一来源）`,
          where: `sys_permission[${ctx.db.databaseName}]`,
        });
      }
    }

    const notes = [
      `PERMISSIONS ${inConstant.size} 条 · sys_permission ${inDb.size} 条 · 交集 ${[...inConstant].filter((c) => inDb.has(c)).length} 条`,
    ];
    return findings.length > 0
      ? fail('R1', permissionCodesVsDatabase.title, findings, notes)
      : pass('R1', permissionCodesVsDatabase.title, notes);
  },
};

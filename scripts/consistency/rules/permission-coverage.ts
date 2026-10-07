import { readFileSync } from 'node:fs';

import { ADMIN_SRC, listSourceFiles, repoRelative, SERVER_SRC } from '../fs.ts';
import { fail, pass, type Finding, type Rule, type RuleContext } from '../types.ts';
import {
  permissionLiteralHits,
  requirePermissionHits,
} from './permission-scan.ts';

/**
 * 规则 6（计划 M5-T4）：权限码落点**双向**审计——交接说明那句判据是
 * 「每个权限码在界面上有真实落点，不多不少」，两头都要机械核对：
 *
 *   (a) 后端：每个码至少一处 `@RequirePermission('码')`。没有守卫的码最危险——
 *       前端藏了按钮、后端不设防，越权直连接口就绕过去了；
 *   (b) 前端：每个码至少一处真实落点。后端守着一个界面上没人点得到的码，
 *       说明的是"界面漏做了"，不是"权限齐了"。
 *
 * "不多"那一半由 R5 负责（前端码字面量 ⊆ PERMISSIONS），与本规则合成闭环。
 *
 * **落点的三种形态**（第二、三种的区别来自 [权限模型设计.md](../../../../docs/权限模型设计.md) §3.7：
 * `sys_menu.auth_code` 只挂在 button 节点上，页面可见性走角色 `authority`，所以页面级码在源码里
 * 不会出现字面量）：
 *   1. 源码里的码字面量——`v-access:code` / `hasAccessByCodes` 这类按钮、区块级落点；
 *   2. `sys_menu.auth_code`——菜单里的按钮节点本身就是落点；
 *   3. **页面级码**（`:list`/`:read`/`:view`）落在整页/整块，登记在 `PAGE_CODE_SITES` 里、
 *      由菜单入口进入。这张表就是 T4 的**审计记录**：规则会核对登记的菜单节点真的存在于
 *      `sys_menu`、登记的码真的在 PERMISSIONS 里——表烂了会当场红，不会变成没人信的表。
 *
 * **P1（二期）码列入白名单**：`proto:release:download`（版本下载）与 `proto:accesslog:export`
 * （访问记录导出）在权限模型设计里标的是 P1、本期不实现，没有落点是预期而不是缺口。
 * 将来实现时把码从白名单删掉，这条规则立刻开始管它。
 */
const P1_DEFERRED_CODES = new Set([
  'proto:accesslog:export',
  'proto:release:download',
]);

/**
 * 页面级码的落点登记：码 → 它出现在哪个菜单节点（按 `sys_menu.name` 认）。
 * 一个界面可以承载多个码（如 `system:user:read` 的落点是设置页里的用户管理 Tab）。
 */
const PAGE_CODE_SITES: Record<string, string[]> = {
  'dashboard:workspace:view': ['Workspace'],
  'proto:project:list': ['ProtoProject'],
  'proto:prototype:list': ['ProtoProjectDetail'],
  'proto:prototype:read': ['ProtoPrototypeDetail'],
  'proto:release:list': ['ProtoPrototypeDetail'],
  'system:role:read': ['SystemSettingRole'],
  'system:user:read': ['SystemSettingUser'],
};

function collect(
  files: string[],
  hit: (content: string) => Array<{ code: string; index: number }>,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const { code } of hit(content)) {
      const list = found.get(code);
      if (list) {
        list.push(repoRelative(file));
      } else {
        found.set(code, [repoRelative(file)]);
      }
    }
  }
  return found;
}

export const permissionCodeCoverage: Rule = {
  id: 'R6',
  title: '权限码落点双向：后端有 @RequirePermission、前端有落点（P1 码除外）',
  run(ctx: RuleContext) {
    const guarded = collect(listSourceFiles(SERVER_SRC), (content) =>
      content.includes('@RequirePermission') ? requirePermissionHits(content) : [],
    );
    const landed = collect(listSourceFiles(ADMIN_SRC), permissionLiteralHits);

    // 菜单按钮节点本身就是落点
    const menuNames = new Set(ctx.db.menus.map((menu) => menu.name));
    for (const menu of ctx.db.menus) {
      if (menu.authCode === null) continue;
      const list = landed.get(menu.authCode);
      const where = `sys_menu#${menu.id}`;
      if (list) {
        list.push(where);
      } else {
        landed.set(menu.authCode, [where]);
      }
    }

    const findings: Finding[] = [];

    // 落点表自检：登记的码要在 PERMISSIONS 里、登记的菜单节点要真的存在
    for (const [code, sites] of Object.entries(PAGE_CODE_SITES)) {
      if (!ctx.permissionCodes.has(code)) {
        findings.push({
          message: `落点表登记了 PERMISSIONS 里没有的码 "${code}"（删掉这一行或补常量）`,
          where: 'permission-coverage.ts:PAGE_CODE_SITES',
        });
      }
      for (const site of sites) {
        if (!menuNames.has(site)) {
          findings.push({
            message: `码 "${code}" 登记的落点菜单节点 "${site}" 在 sys_menu 里不存在`,
            where: 'permission-coverage.ts:PAGE_CODE_SITES',
          });
        }
      }
    }

    let deferred = 0;
    let paged = 0;
    for (const code of [...ctx.permissionCodes].sort()) {
      if (P1_DEFERRED_CODES.has(code)) {
        deferred += 1;
        continue;
      }
      if (!guarded.has(code)) {
        findings.push({
          message: `权限码 "${code}" 在 apps/server/src 没有任何 @RequirePermission 守卫——前端藏了按钮、后端不设防`,
          where: 'PERMISSIONS',
        });
      }
      if (landed.has(code)) continue;
      const sites = PAGE_CODE_SITES[code];
      if (sites) {
        paged += 1;
        continue;
      }
      findings.push({
        message: `权限码 "${code}" 在界面上没有任何落点（源码码字面量 / sys_menu.auth_code / 页面落点表都没有）——后端守着一个点不到的码`,
        where: 'PERMISSIONS',
      });
    }

    const notes = [
      `PERMISSIONS ${ctx.permissionCodes.size} 个码：后端有守卫 ${guarded.size} 个、源码/按钮落点 ${landed.size} 个、页面级落点 ${paged} 个、P1 白名单 ${deferred} 个`,
      `白名单（P1，本期不实现）：${[...P1_DEFERRED_CODES].sort().join('、')}`,
    ];
    return findings.length > 0
      ? fail('R6', permissionCodeCoverage.title, findings, notes)
      : pass('R6', permissionCodeCoverage.title, notes);
  },
};

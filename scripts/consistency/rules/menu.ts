import { readFileSync } from 'node:fs';

import { ADMIN_VIEWS, isFile, repoRelative } from '../fs.ts';
import {
  fail,
  pass,
  ROOT,
  type DbSnapshot,
  type Finding,
  type Rule,
  type RuleContext,
} from '../types.ts';

/** vben 的 layoutMap 键（apps/admin/src/router/access.ts）：不是 views 文件，属合法值。 */
const LAYOUT_COMPONENTS = new Set(['BasicLayout', 'IFrameView']);

/** 菜单数据来源：seed 里的字面量。报错定位到它，比只报库里的行 id 更能直接动手改。 */
const SEED_MENUS_FILE = `${ROOT}/packages/db/src/seed/menus.ts`;

/** component/auth_code → seed 里出现该字面量的行号（同一码可能多处，按顺序消费）。 */
function buildSeedLineIndex(): Map<string, number[]> {
  const index = new Map<string, number[]>();
  let text: string;
  try {
    text = readFileSync(SEED_MENUS_FILE, 'utf8');
  } catch {
    return index; // seed 文件换了位置也不该让一致性检查崩
  }
  text.split('\n').forEach((line, offset) => {
    for (const match of line.matchAll(/'([^'\n]+)'/g)) {
      const literal = match[1];
      if (!literal) continue;
      const lines = index.get(literal);
      if (lines) lines.push(offset + 1);
      else index.set(literal, [offset + 1]);
    }
  });
  return index;
}

/** 取该字面量在 seed 里的位置；找不到就回落到"库里的那一行"标识。 */
function seedWhere(
  index: Map<string, number[]>,
  literal: string,
  db: DbSnapshot,
  menuId: string,
): string {
  const lines = index.get(literal);
  const line = lines?.shift();
  return line
    ? `${repoRelative(SEED_MENUS_FILE)}:${line} · sys_menu#${menuId} (${db.databaseName})`
    : `sys_menu#${menuId} (${db.databaseName})`;
}

/**
 * 复刻 packages/utils/src/helpers/generate-routes-backend.ts 的 normalizeViewPath：
 * 去相对前缀 → 补前导 / → 去掉 /views 前缀。pageMap 的键来自 apps/admin/src/views 下
 * 递归收集的 .vue 归一化结果，所以 "<path>.vue" 必须能在该目录找到同名文件。
 */
export function normalizeViewPath(path: string): string {
  const stripped = path.replace(/^(\.\/|\.\.\/)+/, '');
  const withSlash = stripped.startsWith('/') ? stripped : `/${stripped}`;
  return withSlash.replace(/^\/views/, '');
}

/**
 * 里程碑豁免：计划 §5 把 proto/* 视图排在 M2–M4，但菜单树按 权限模型设计 §seed 第 4 步
 * 在 M1-T3 一次性下发（M1 Gate G3 要对比 4 个角色的侧栏差异，缺了 proto 节点就没得对比）。
 * 键是 sys_menu.component 的字面量。
 *
 * 这不是放宽规则：视图落地后必须把对应条目删掉，否则本规则以"豁免已过期"失败，
 * 所以每个里程碑的 Gate 都会被这里卡一次。
 *
 * M4-T11 交付 `views/proto/accesslog/index.vue` 后本表清空——留空不是装饰：
 * 下一次在 M1-T3 的 seed 里预下发一个还没排到视图的菜单节点时，必须往这里补一条，
 * 否则 R3a 会在 Gate 上直接点名它。
 */
const VIEWS_DEFERRED_UNTIL: Record<string, 'M2' | 'M3' | 'M4'> = {};

/**
 * 规则 3a：sys_menu.component ↔ apps/admin/src/views 真实文件
 * —— vben 运行时那句 `route component is invalid` 的机械版（§6.4 N2、§7 F-3）。
 */
export const menuComponentsExist: Rule = {
  id: 'R3a',
  title: 'sys_menu.component ↔ apps/admin/src/views 实际文件',
  run(ctx: RuleContext) {
    const seedLines = buildSeedLineIndex();
    const findings: Finding[] = [];
    let checked = 0;
    const missing: string[] = [];
    const deferred: string[] = [];
    const seenDeferred = new Set<string>();

    for (const menu of ctx.db.menus) {
      const component = menu.component;
      if (component === null || LAYOUT_COMPONENTS.has(component)) continue;
      checked += 1;
      const normalized = normalizeViewPath(component);
      const pageKey = normalized.endsWith('.vue') ? normalized : `${normalized}.vue`;
      const absolute = `${ADMIN_VIEWS}${pageKey}`;
      const exists = isFile(absolute);
      const grace = VIEWS_DEFERRED_UNTIL[normalized];

      if (exists) {
        if (grace) {
          seenDeferred.add(normalized);
          findings.push({
            message:
              `视图 ${normalized}.vue 已经存在，但 R3a 的里程碑豁免（原计划 ${grace} 落地）还没删；` +
              `豁免只用于"视图尚未排进当前里程碑"，过期不清就等于永久漏检`,
            where: seedWhere(seedLines, component, ctx.db, menu.id),
          });
        }
        continue;
      }

      if (grace) {
        deferred.push(`${menu.name}(${normalized}→${grace})`);
        continue;
      }

      missing.push(menu.name);
      findings.push({
        message:
          `sys_menu "${menu.name}" 的 component "${component}" 归一化为 "${pageKey}"，` +
          `但 ${repoRelative(absolute)} 不存在 → 浏览器会打印 route component is invalid 并落到 404/403`,
        where: seedWhere(seedLines, component, ctx.db, menu.id),
      });
    }

    // 豁免表里指向已消失菜单的条目也要能被察觉（菜单改名/删掉后豁免会永远残留）
    for (const [normalized, milestone] of Object.entries(VIEWS_DEFERRED_UNTIL)) {
      const stillSeeded = ctx.db.menus.some(
        (menu) =>
          menu.component !== null &&
          normalizeViewPath(menu.component) === normalized,
      );
      if (!stillSeeded && !seenDeferred.has(normalized)) {
        findings.push({
          message:
            `R3a 豁免表里的 ${normalized}（原定 ${milestone}）在 sys_menu 已不存在对应节点，请删掉这一条`,
          where: repoRelative(`${ROOT}/scripts/consistency/rules/menu.ts`),
        });
      }
    }

    const notes = [
      `${checked} 个带 component 的菜单节点，${checked - missing.length - deferred.length} 个有对应 .vue 文件` +
        (deferred.length > 0 ? `；按里程碑豁免：${deferred.join(', ')}` : '') +
        (missing.length > 0 ? `；缺失：${missing.join(', ')}` : ''),
    ];
    if (deferred.length > 0) {
      notes.push(
        '豁免来自计划 §5 的里程碑排期（proto/* 视图属 M2–M4），不是把规则改成"可以没有视图"：' +
          '对应里程碑交付时必须删除条目，且被点击的菜单在运行时会落到 route component is invalid。',
      );
    }
    return findings.length > 0
      ? fail('R3a', menuComponentsExist.title, findings, notes)
      : pass('R3a', menuComponentsExist.title, notes);
  },
};

/**
 * 规则 3b：sys_menu.auth_code ⊆ PERMISSIONS。
 * button 节点的 auth_code 是前端按钮显隐的唯一来源，写错＝按钮永不显示（查起来很费劲）。
 */
export const menuAuthCodes: Rule = {
  id: 'R3b',
  title: 'sys_menu.auth_code ⊆ PERMISSIONS',
  run(ctx: RuleContext) {
    const seedLines = buildSeedLineIndex();
    const findings: Finding[] = [];
    let checked = 0;
    for (const menu of menusWithAuthCode(ctx.db)) {
      checked += 1;
      const authCode = menu.authCode as string;
      if (!ctx.permissionCodes.has(authCode)) {
        findings.push({
          message: `菜单 "${menu.name}" 的 auth_code "${authCode}" 不在 PERMISSIONS 常量里`,
          where: seedWhere(seedLines, authCode, ctx.db, menu.id),
        });
      }
    }

    const notes = [`${checked} 个 button 节点带 auth_code，全部能在 PERMISSIONS 中找到`];
    return findings.length > 0
      ? fail('R3b', menuAuthCodes.title, findings, notes)
      : pass('R3b', menuAuthCodes.title, notes);
  },
};

function menusWithAuthCode(db: DbSnapshot): DbSnapshot['menus'] {
  return db.menus.filter((menu) => menu.authCode !== null && menu.authCode !== '');
}

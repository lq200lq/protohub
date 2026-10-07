import { readFileSync } from 'node:fs';

import { listSourceFiles, lineIndexOf, repoRelative, ADMIN_SRC } from '../fs.ts';
import { fail, pass, type Finding, type Rule, type RuleContext } from '../types.ts';
import { permissionLiteralHits } from './permission-scan.ts';

/**
 * 规则 5：前端出现的权限码字面量（proto:* / system:* / dashboard:*）必须都在 PERMISSIONS 里。
 * 前端按钮用 hasAccessByCodes(['system:user:create']) 这类字面量，码写错不会报错，只会"按钮不见了"。
 *
 * 扫描实现收在 permission-scan.ts（R2/R5/R7 共用一处）。
 */
export const frontendPermissionCodes: Rule = {
  id: 'R5',
  title: '前端引用的权限码 ⊆ PERMISSIONS',
  run(ctx: RuleContext) {
    const files = listSourceFiles(ADMIN_SRC);
    const findings: Finding[] = [];
    let checked = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const hit of permissionLiteralHits(content)) {
        checked += 1;
        if (!ctx.permissionCodes.has(hit.code)) {
          findings.push({
            message: `前端字符串字面量 "${hit.code}" 不在 PERMISSIONS 常量里`,
            where: `${repoRelative(file)}:${lineIndexOf(content, hit.index)}`,
          });
        }
      }
    }

    const notes = [
      `扫描 ${files.length} 个 apps/admin/src 源文件，命中 ${checked} 处权限码字面量`,
    ];
    return findings.length > 0
      ? fail('R5', frontendPermissionCodes.title, findings, notes)
      : pass('R5', frontendPermissionCodes.title, notes);
  },
};

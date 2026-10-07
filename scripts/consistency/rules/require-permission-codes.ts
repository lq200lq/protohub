import { readFileSync } from 'node:fs';

import { listSourceFiles, lineIndexOf, repoRelative, SERVER_SRC } from '../fs.ts';
import { fail, pass, type Finding, type Rule, type RuleContext } from '../types.ts';
import { requirePermissionHits } from './permission-scan.ts';

/**
 * 规则 2（§6.4 N1）：apps/server/src 里 @RequirePermission('...') 的每个字符串实参
 * 都必须在 PERMISSIONS 里。计划明确要求"正则扫源码"，不引 TS 编译器 API。
 *
 * 扫描实现收在 permission-scan.ts（R2 / R5 / R7 共用一处：支持跨行、一个装饰器多个码）。
 */
export const requirePermissionCodes: Rule = {
  id: 'R2',
  title: '@RequirePermission 的码都在 PERMISSIONS 里',
  run(ctx: RuleContext) {
    const files = listSourceFiles(SERVER_SRC);
    const findings: Finding[] = [];
    let checked = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes('@RequirePermission')) continue;

      for (const hit of requirePermissionHits(content)) {
        checked += 1;
        if (!ctx.permissionCodes.has(hit.code)) {
          findings.push({
            message: `@RequirePermission('${hit.code}') 的码不在 PERMISSIONS 常量里`,
            where: `${repoRelative(file)}:${lineIndexOf(content, hit.index)}`,
          });
        }
      }
    }

    const notes = [
      `扫描 ${files.length} 个 apps/server/src 源文件，校验 ${checked} 处 @RequirePermission 码`,
    ];
    return findings.length > 0
      ? fail('R2', requirePermissionCodes.title, findings, notes)
      : pass('R2', requirePermissionCodes.title, notes);
  },
};

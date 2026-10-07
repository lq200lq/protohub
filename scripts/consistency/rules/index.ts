import { frontendPermissionCodes } from './frontend-codes.ts';
import { codeRuleParity } from './code-rule-parity.ts';
import { menuAuthCodes, menuComponentsExist } from './menu.ts';
import { permissionCodeCoverage } from './permission-coverage.ts';
import { permissionCodesVsDatabase } from './permission-codes-vs-db.ts';
import { requirePermissionCodes } from './require-permission-codes.ts';
import type { Rule } from '../types.ts';

/** 顺序 = 输出顺序：先权限码，再菜单，再编码规则，最后前端落点。 */
export const RULES: Rule[] = [
  permissionCodesVsDatabase,
  requirePermissionCodes,
  menuComponentsExist,
  menuAuthCodes,
  codeRuleParity,
  frontendPermissionCodes,
  permissionCodeCoverage,
];

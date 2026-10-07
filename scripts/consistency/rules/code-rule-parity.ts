import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIGRATIONS_DIR, repoRelative } from '../fs.ts';
import { fail, pass, type Finding, type Rule, type RuleContext } from '../types.ts';

/**
 * 规则 4（§3.7 红线 + 决策 D-20）：编码规则只有一份。
 * DB 的 CHECK ("code" ~ '…') 与 VARCHAR(n) 必须等于 shared CODE_RULE 的 pattern / maxLength，
 * 否则出现"前端放行、后端放行、DB 拒收"（或反过来）——三端漂移里最难查的一类。
 */
const CODE_CHECK =
  /ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+_code_check)"\s+CHECK \("code" ~ '([^']+)'\)/g;
const CREATE_TABLE = /CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g;
const CODE_COLUMN = /^\s*"code"\s+VARCHAR\((\d+)\)/im;

/** 只认这两个业务码列：sys_* 的 code 是枚举/角色标识，不受 CODE_RULE 约束。 */
const CODE_RULE_TABLES = new Set(['proto_project', 'proto_prototype']);

interface MigrationFile {
  path: string;
  sql: string;
}

function listMigrationSql(): MigrationFile[] {
  let paths: string[] = [];
  try {
    paths = walkSql(MIGRATIONS_DIR);
  } catch {
    return [];
  }
  return paths.map((path) => ({ path, sql: readFileSync(path, 'utf8') }));
}

function walkSql(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSql(full));
    else if (entry.isFile() && entry.name.endsWith('.sql')) out.push(full);
  }
  return out.sort();
}

interface ColumnInfo {
  length: number;
  where: string;
}

export const codeRuleParity: Rule = {
  id: 'R4',
  title: 'DB CHECK(code) 正则/长度 = shared CODE_RULE',
  run(ctx: RuleContext) {
    const expectedPattern = ctx.codeRule.pattern.source;
    const notes: string[] = [
      `shared CODE_RULE: pattern ${expectedPattern} · maxLength ${ctx.codeRule.maxLength}`,
    ];

    const files = listMigrationSql();
    if (files.length === 0) {
      return fail(
        'R4',
        codeRuleParity.title,
        [
          {
            message: 'packages/db/prisma/migrations 下找不到任何 .sql，无法核对 DB 侧编码规则',
            where: repoRelative(MIGRATIONS_DIR),
          },
        ],
        notes,
      );
    }

    // 先建 "表名 → code 列长度" 索引（列长度在 CREATE TABLE 里，CHECK 在后面单独 ALTER）
    const columns = new Map<string, ColumnInfo>();
    for (const file of files) {
      for (const tableMatch of file.sql.matchAll(CREATE_TABLE)) {
        const table = tableMatch[1];
        const body = tableMatch[2];
        if (!table || !body || !CODE_RULE_TABLES.has(table)) continue;
        const columnMatch = CODE_COLUMN.exec(body);
        if (!columnMatch) continue;
        columns.set(table, {
          length: Number(columnMatch[1]),
          where: `${repoRelative(file.path)}:${lineOf(file.sql, (tableMatch.index ?? 0) + (body.indexOf(columnMatch[0]) ?? -1))}`,
        });
      }
    }

    const findings: Finding[] = [];
    const constraints: string[] = [];
    for (const file of files) {
      for (const match of file.sql.matchAll(CODE_CHECK)) {
        const [, table, constraint, dbPattern] = match;
        if (!table || !constraint || !dbPattern) continue;
        if (!CODE_RULE_TABLES.has(table)) continue;
        constraints.push(constraint);
        const where = `${repoRelative(file.path)}:${lineOf(file.sql, match.index ?? 0)}`;

        if (dbPattern !== expectedPattern) {
          findings.push({
            message: `${table} 的 CHECK 正则 '${dbPattern}' ≠ shared CODE_RULE.pattern ${expectedPattern}`,
            where,
          });
        }

        const column = columns.get(table);
        if (!column) {
          findings.push({
            message: `${table} 的 CREATE TABLE 里找不到 "code" VARCHAR(n)，无法核对长度`,
            where,
          });
          continue;
        }
        if (column.length !== ctx.codeRule.maxLength) {
          findings.push({
            message: `${table}."code" 是 VARCHAR(${column.length})，CODE_RULE.maxLength 是 ${ctx.codeRule.maxLength}`,
            where: column.where,
          });
        }
      }
    }

    if (constraints.length === 0) {
      return fail(
        'R4',
        codeRuleParity.title,
        [
          {
            message:
              'migrations 里没有 proto_project/proto_prototype 的 code CHECK 约束（约束名应形如 <table>_code_check）',
            where: repoRelative(MIGRATIONS_DIR),
          },
        ],
        notes,
      );
    }

    notes.push(`已核对 ${constraints.length} 处：${constraints.join('、')}`);
    return findings.length > 0
      ? fail('R4', codeRuleParity.title, findings, notes)
      : pass('R4', codeRuleParity.title, notes);
  },
};

function lineOf(content: string, index: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(index, content.length));
  for (let i = 0; i < end; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

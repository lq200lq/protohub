import type { RuleResult } from './types.ts';

const ICON: Record<RuleResult['status'], string> = {
  failed: '✘',
  passed: '✔',
  skipped: '⊘',
};

export function printResults(
  results: RuleResult[],
  header: string[],
): boolean {
  for (const line of header) console.log(line);
  console.log('');

  for (const result of results) {
    console.log(`${ICON[result.status]} ${result.id} ${result.title}`);
    for (const note of result.notes) {
      console.log(`      ${note}`);
    }
    if (result.skipReason) console.log(`      ${result.skipReason}`);
    for (const finding of result.findings) {
      console.log(`      ${finding.where} — ${finding.message}`);
    }
  }

  const failed = results.filter((result) => result.status === 'failed').length;
  const passed = results.filter((result) => result.status === 'passed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const offenderCount = results.reduce(
    (sum, result) => sum + result.findings.length,
    0,
  );

  console.log('');
  console.log(
    `规则 ${passed} 通过 / ${failed} 失败${skipped > 0 ? ` / ${skipped} 跳过` : ''}` +
      ` · ${offenderCount} 处违规 → ${failed > 0 ? 'check:consistency 失败' : 'check:consistency 通过'}`,
  );
  return failed === 0;
}

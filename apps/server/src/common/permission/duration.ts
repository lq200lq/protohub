/**
 * JWT 的 `expiresIn`（`2h`/`7d`）与 Cookie 的 `Max-Age`（秒）必须来自同一个配置值，
 * 否则会出现"Cookie 还在、token 已死"这种刷新流程反复失败的状态，所以在这里做一次换算。
 */
const DURATION_PATTERN = /^(\d+)\s*([smhd])$/;

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

export function parseDurationSeconds(input: string): number {
  const match = DURATION_PATTERN.exec(input.trim().toLowerCase());
  const amount = match?.[1];
  const unit = match?.[2];
  const secondsPerUnit = unit === undefined ? undefined : SECONDS_PER_UNIT[unit];
  if (!amount || !unit || secondsPerUnit === undefined) {
    throw new RangeError(
      `时长格式不合法："${input}"，应为 <正整数><s|m|h|d>，例如 2h、7d`,
    );
  }
  return Number(amount) * secondsPerUnit;
}

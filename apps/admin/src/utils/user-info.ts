/**
 * forcePasswordChange 是后端契约字段（后端接口设计 §2.5），
 * 经 toVbenUserInfo 的 spread 保留在持久化的 userInfo 上，
 * vben 的 UserInfo 类型不认识它，这里做唯一一处受控读取。
 */
export function hasForcePasswordChange(
  userInfo: null | Record<string, unknown> | undefined,
): boolean {
  if (!userInfo) {
    return false;
  }
  return userInfo.forcePasswordChange === true;
}

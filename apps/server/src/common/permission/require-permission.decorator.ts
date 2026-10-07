import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSION_KEY = 'protohub:required-permissions';

/** 一个接口可标多个权限码，满足任一即通过（OR）。 */
export const RequirePermission = (...codes: string[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, codes);

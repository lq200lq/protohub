import { describe, expect, it } from 'vitest';

import { readAppVersion } from '../common/app-version';
import { HealthController } from './health.controller';

describe('GET /api/health（后端接口设计 §9.4）', () => {
  it('返回 status:ok 与版本号，不带其它可被外部探测的信息', () => {
    const controller = new HealthController();

    expect(controller.health()).toEqual({
      status: 'ok',
      version: readAppVersion(),
    });
    expect(Object.keys(controller.health()).sort()).toEqual(['status', 'version']);
  });

  it('版本号取的是本包 package.json，不是写死的字符串', () => {
    expect(/^\d+\.\d+\.\d+/.test(readAppVersion())).toBe(true);
  });
});

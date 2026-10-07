import { PERMISSION_CODES } from '@protohub/shared';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums';
import { describe, expect, it } from 'vitest';

import { IS_PUBLIC_KEY } from '../../../common/decorator/public.decorator';
import { REQUIRE_PERMISSION_KEY } from '../../../common/permission/require-permission.decorator';
import { AuthController } from '../../../modules/auth/auth.controller';
import { UserProfileController } from '../user/user-profile.controller';
import { LogController } from '../log/log.controller';
import { MenuController } from '../menu/menu.controller';
import { PermissionController } from '../permission/permission.controller';
import { RoleController } from '../role/role.controller';
import { UserController } from '../user/user.controller';

/**
 * F-4 自检（迭代实施计划 §8）：**系统管理的每条写接口（POST/PUT/PATCH/DELETE）必须带权限码元数据**，
 * 且码必须在 PERMISSIONS 字典里。这里不启 Nest 上下文，直接读装饰器元数据——
 * AuthGuard 消费的正是同一份 REQUIRE_PERMISSION_KEY，所以这份断言与运行时行为一致。
 *
 * 例外白名单（设计如此，不是漏标）：
 * - @Public 路由（/auth/login、/auth/refresh）：本来就不允许挂权限码；
 * - "仅需登录"的自助路由（logout、/user/profile、/user/password、/user/info）：见 §2.3~2.8 与权限模型 §8.1。
 */

const WRITE_METHOD_IDS: readonly number[] = [
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
];

interface ControllerRoute {
  readonly methodId: number;
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly isPublic: boolean;
  readonly codes: readonly string[] | undefined;
}

// Nest 控制器 here 只当作"带 prototype 的类"用：读装饰器元数据不需要实例化。
type ControllerClass = { readonly prototype: object };

function routesOf(controller: ControllerClass): ControllerRoute[] {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, controller);
  const names = Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
  return names
    .map((name) => {
      const handler = Reflect.get(controller.prototype, name);
      if (typeof handler !== 'function') {
        return null;
      }
      const methodId = Reflect.getMetadata(METHOD_METADATA, handler);
      const path = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof methodId !== 'number' || typeof path !== 'string') {
        return null;
      }
      return {
        methodId,
        method: String(RequestMethod[methodId]),
        path: joinPath(String(controllerPath), path),
        handler: name,
        isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
        codes: Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler),
      };
    })
    .filter((route): route is ControllerRoute => route !== null);
}

function joinPath(base: string, sub: string): string {
  const cleanBase = base.startsWith('/') ? base : `/${base}`;
  if (sub === '/') {
    return cleanBase;
  }
  return `${cleanBase}${sub.startsWith('/') ? sub : `/${sub}`}`;
}

const SYSTEM_CONTROLLERS: readonly { readonly name: string; readonly controller: ControllerClass }[] = [
  { name: 'UserController', controller: UserController },
  { name: 'RoleController', controller: RoleController },
  { name: 'MenuController', controller: MenuController },
  { name: 'PermissionController', controller: PermissionController },
  { name: 'LogController', controller: LogController },
];

describe('系统管理写接口权限元数据全覆盖（F-4）', () => {
  for (const { name, controller } of SYSTEM_CONTROLLERS) {
    it(`${name}：每条写路由都带字典内的权限码`, () => {
      const routes = routesOf(controller);
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        if (!WRITE_METHOD_IDS.includes(route.methodId)) {
          continue;
        }
        expect(route.isPublic, `${route.method} ${route.path} 是写接口却标了 @Public`).toBe(false);
        expect(
          route.codes,
          `${name}.${route.handler}（${route.method} ${route.path}）是写接口但没有 @RequirePermission`,
        ).toBeDefined();
        expect(route.codes?.length).toBeGreaterThan(0);
        for (const code of route.codes ?? []) {
          expect(PERMISSION_CODES, `路由 ${route.method} ${route.path} 挂了字典外的码 ${code}`).toContain(code);
        }
      }
    });
  }

  it('全部路由（含 GET）挂出的码都必须真实存在', () => {
    for (const { controller } of SYSTEM_CONTROLLERS) {
      for (const route of routesOf(controller)) {
        for (const code of route.codes ?? []) {
          expect(PERMISSION_CODES).toContain(code);
        }
      }
    }
  });

  it('auth/自助路由保持"无权限码"设计（改动此断言前先看 权限模型设计 §8.1）', () => {
    for (const controller of [AuthController, UserProfileController]) {
      for (const route of routesOf(controller)) {
        if (route.isPublic) {
          expect(route.codes, `@Public 路由 ${route.path} 不应再挂权限码`).toBeUndefined();
        }
      }
    }
  });
});

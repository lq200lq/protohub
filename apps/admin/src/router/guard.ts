import type { Router } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';
import { startProgress, stopProgress } from '@vben/utils';

import { getAccessCodesApi } from '#/api';
import { accessRoutes, coreRouteNames } from '#/router/routes';
import { useAuthStore } from '#/store';
import { hasForcePasswordChange } from '#/utils/user-info';

import { generateAccess } from './access';

/** 首登强制改密的落点（前端设计 §4 /profile、§3.9 路由守卫拦截） */
const FORCE_PASSWORD_PATH = '/profile';

/**
 * 通用守卫配置
 * @param router
 */
function setupCommonGuard(router: Router) {
  // 记录已经加载的页面
  const loadedPaths = new Set<string>();

  router.beforeEach((to) => {
    to.meta.loaded = loadedPaths.has(to.path);

    // 页面加载进度条
    if (!to.meta.loaded && preferences.transition.progress) {
      startProgress();
    }
    return true;
  });

  router.afterEach((to) => {
    // 记录页面是否加载,如果已经加载，后续的页面切换动画等效果不在重复执行

    loadedPaths.add(to.path);

    // 关闭页面加载进度条
    if (preferences.transition.progress) {
      stopProgress();
    }
  });
}

/**
 * 权限访问守卫配置
 * @param router
 */
function setupAccessGuard(router: Router) {
  router.beforeEach(async (to, from) => {
    const accessStore = useAccessStore();
    const userStore = useUserStore();
    const authStore = useAuthStore();

    // 基本路由，这些路由不需要进入权限拦截
    if (coreRouteNames.includes(to.name as string)) {
      if (to.path === LOGIN_PATH && accessStore.accessToken) {
        return decodeURIComponent(
          (to.query?.redirect as string) ||
            userStore.userInfo?.homePath ||
            preferences.app.defaultHomePath,
        );
      }
      return true;
    }

    // accessToken 检查
    if (!accessStore.accessToken) {
      // 明确声明忽略权限访问权限，则可以访问
      if (to.meta.ignoreAccess) {
        return true;
      }

      // 没有访问权限，跳转登录页面
      if (to.fullPath !== LOGIN_PATH) {
        return {
          path: LOGIN_PATH,
          // 如不需要，直接删除 query
          query:
            to.fullPath === preferences.app.defaultHomePath
              ? {}
              : { redirect: encodeURIComponent(to.fullPath) },
          // 携带当前跳转的页面，登录后重新跳转该页面
          replace: true,
        };
      }
      return to;
    }

    // 是否已经生成过动态路由
    if (accessStore.isAccessChecked) {
      return true;
    }

    // 生成路由表
    // 整页加载一律重新取一次用户信息与权限码：这两份是登录那一刻的快照，存在 localStorage 里，
    // 只在登录时取会让"改了角色权限后该用户刷新页面"仍按旧码渲染 Tab/按钮（M1-T10 + Gate G4）。
    let userInfo;
    try {
      const [info, accessCodes] = await Promise.all([
        authStore.fetchUserInfo(),
        getAccessCodesApi(),
      ]);
      userInfo = info;
      accessStore.setAccessCodes(accessCodes);
    } catch (error) {
      // 请求层在 401 分支里已经把 accessToken 清空（并顺手把用户送去登录页），
      // 这里只补一个"带 redirect 的登录页跳转"作为兜底：把异常原样抛给 vue-router 会留下
      // R0010/R0011 未捕获错误（禁用用户后刷新页面就是这条路径）。
      if (accessStore.accessToken) {
        throw error;
      }
      return {
        path: LOGIN_PATH,
        query:
          to.fullPath === preferences.app.defaultHomePath
            ? {}
            : { redirect: encodeURIComponent(to.fullPath) },
        replace: true,
      };
    }
    const userRoles = userInfo.roles ?? [];

    // 生成菜单和路由
    const { accessibleMenus, accessibleRoutes } = await generateAccess({
      roles: userRoles,
      router,
      // 则会在菜单中显示，但是访问会被重定向到403
      routes: accessRoutes,
    });

    // 保存菜单信息和路由信息
    accessStore.setAccessMenus(accessibleMenus);
    accessStore.setAccessRoutes(accessibleRoutes);
    accessStore.setIsAccessChecked(true);
    const redirectPath = (from.query.redirect ??
      (to.path === preferences.app.defaultHomePath
        ? userInfo.homePath || preferences.app.defaultHomePath
        : to.fullPath)) as string;

    return {
      ...router.resolve(decodeURIComponent(redirectPath)),
      replace: true,
    };
  });
}

/**
 * 首登强制改密守卫（前端设计 §3.9）
 * 必须在 setupAccessGuard 之后注册：那时动态路由已生成、userInfo 已拉取，
 * /profile 是可达的。改密成功即 token_version+1 → 登出，所以这里只拦不改。
 * @param router
 */
function setupForcePasswordGuard(router: Router) {
  router.beforeEach((to) => {
    const accessStore = useAccessStore();
    const userStore = useUserStore();

    if (!accessStore.accessToken || to.meta.ignoreAccess) {
      return true;
    }
    if (!hasForcePasswordChange(userStore.userInfo)) {
      return true;
    }
    if (to.path === FORCE_PASSWORD_PATH) {
      return true;
    }
    return {
      path: FORCE_PASSWORD_PATH,
      query: { redirect: encodeURIComponent(to.fullPath) },
      replace: true,
    };
  });
}

/**
 * 项目守卫配置
 * @param router
 */
function createRouterGuard(router: Router) {
  /** 通用 */
  setupCommonGuard(router);
  /** 权限访问 */
  setupAccessGuard(router);
  /** 首登强制改密 */
  setupForcePasswordGuard(router);
}

export { createRouterGuard };

import { defineOverridesPreferences } from '@vben/preferences';

/**
 * @description 项目配置文件
 * 只覆盖 ProtoHub 需要的配置，其余沿用 vben 默认值
 * !!! 更改配置后请清空缓存，否则可能不生效
 */
export const overridesPreferences = defineOverridesPreferences({
  app: {
    accessMode: 'backend',
    defaultHomePath: '/dashboard/workspace',
    enableRefreshToken: true,
    // 刷新令牌也失效（401）时弹“登录过期”浮层重新登录，而不是整页跳转
    loginExpiredMode: 'modal',
    name: import.meta.env.VITE_APP_TITLE,
  },
  theme: {
    colorPrimary: '#2563eb',
  },
});

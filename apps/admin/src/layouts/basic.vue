<script lang="ts" setup>
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';

import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useWatermark } from '@vben/hooks';
import {
  BasicLayout,
  LockScreen,
  UserDropdown,
} from '@vben/layouts';
import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import { $t } from '#/locales';
import ForcePasswordChangeModal from '#/components/auth/ForcePasswordChangeModal.vue';
import PublishTaskFloat from '#/components/proto/PublishTaskFloat.vue';
import { useAuthStore } from '#/store';
import LoginForm from '#/views/_core/authentication/login.vue';

/**
 * 一期没有通知渠道（前端设计 §12：右上铃铛预留位不显示），
 * 所以这里不渲染 Notification，也不放任何 mock 数据。
 * 用户下拉只留两项：账号安全（系统设置的账号安全子菜单）与退出登录。
 */
const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark } = usePreferences();

const menus = computed(() => [
  {
    handler: () => {
      // 个人中心 = 系统设置的账号安全子菜单（前端设计 §3.8），不再单独开路由
      router.push({ path: '/system/setting/security' });
    },
    icon: 'lucide:user',
    text: $t('proto.settings.accountSecurity'),
  },
]);

const avatar = computed(() => {
  return userStore.userInfo?.avatar ?? preferences.app.defaultAvatar;
});

async function handleLogout() {
  await authStore.logout(false);
}

watch(
  () => ({
    enable: preferences.app.watermark,
    content: preferences.app.watermarkContent,
    isDark: isDark.value,
  }),
  async ({ enable, content, isDark: isDarkValue }) => {
    if (enable) {
      const watermarkColor = isDarkValue
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.12)';

      await updateWatermark({
        advancedStyle: {
          colorStops: [
            {
              color: watermarkColor,
              offset: 0,
            },
            {
              color: watermarkColor,
              offset: 1,
            },
          ],
          type: 'linear',
        },
        content:
          content ||
          `${userStore.userInfo?.username} - ${userStore.userInfo?.realName}`,
      });
    } else {
      destroyWatermark();
    }
  },
  {
    immediate: true,
  },
);
</script>

<template>
  <BasicLayout @clear-preferences-and-logout="handleLogout">
    <!-- 框架默认 text-lg 会让 8 字品牌名差 4px 出省略号，降一级到 text-base 完整显示 -->
    <template #logo-text>
      <span class="text-foreground truncate text-base font-semibold text-nowrap">
        {{ preferences.app.name }}
      </span>
    </template>
    <template #user-dropdown>
      <UserDropdown
        :avatar
        :menus
        :text="userStore.userInfo?.realName"
        :description="userStore.userInfo?.email ?? ''"
        @logout="handleLogout"
        @clear-preferences-and-logout="handleLogout"
      />
    </template>
    <template #extra>
      <!-- 401 且刷新令牌也失效 → 登录过期浮层（preferences 里已设为 modal） -->
      <AuthenticationLoginExpiredModal
        v-model:open="accessStore.loginExpired"
        :avatar
      >
        <LoginForm />
      </AuthenticationLoginExpiredModal>
      <!-- forcePasswordChange=true 时拦住整个后台，改密成功即退出重登（后端接口设计 §2.5/§2.8） -->
      <ForcePasswordChangeModal />
      <!-- 关抽屉不该打断发布：任务在右下角继续跑（前端设计 §3.4） -->
      <PublishTaskFloat />
    </template>
    <template #lock-screen>
      <LockScreen :avatar @to-login="handleLogout" />
    </template>
  </BasicLayout>
</template>

<script setup lang="ts">
import type { SettingTabKey } from '#/utils/setting-tabs';

import { computed, ref, watch } from 'vue';

import { Page } from '@vben/common-ui';
import { useAccessStore } from '@vben/stores';

import { Card, TabPane, Tabs } from 'ant-design-vue';
import { useRoute, useRouter } from 'vue-router';

import { $t } from '#/locales';
import { pickSettingTab, resolveSettingTabs } from '#/utils/setting-tabs';

import AccountSecurity from './components/AccountSecurity.vue';
import LogManage from './components/LogManage.vue';
import MenuManage from './components/MenuManage.vue';
import RoleManage from './components/RoleManage.vue';
import UserManage from './components/UserManage.vue';

defineOptions({ name: 'SystemSetting' });

const route = useRoute();
const router = useRouter();
const accessStore = useAccessStore();

/** 无权限的 Tab 直接不渲染（前端设计 §3.8），而不是置灰 */
const visibleTabs = computed(() =>
  resolveSettingTabs(accessStore.accessCodes),
);

const tabLabels: Record<SettingTabKey, string> = {
  log: $t('proto.settings.tabs.log'),
  menu: $t('proto.settings.tabs.menu'),
  role: $t('proto.settings.tabs.role'),
  security: $t('proto.settings.tabs.security'),
  user: $t('proto.settings.tabs.user'),
};

const activeKey = ref<SettingTabKey | undefined>(
  pickSettingTab(route.query.tab as string | undefined, visibleTabs.value),
);

// 外部以 ?tab=xxx 深链进入（用户下拉、登录过期重登后回访）
watch(
  () => route.query.tab,
  (tab) => {
    const next = pickSettingTab(tab as string | undefined, visibleTabs.value);
    if (next !== activeKey.value) {
      activeKey.value = next;
    }
  },
);

watch(activeKey, (tab) => {
  if (tab && route.query.tab !== tab) {
    router.replace({ query: { ...route.query, tab } });
  }
});

// 权限码变化（重新登录/换账号）时，若当前 Tab 已不可见则回落
watch(visibleTabs, (tabs) => {
  if (activeKey.value && !tabs.includes(activeKey.value)) {
    activeKey.value = tabs[0];
  }
});
</script>

<template>
  <Page auto-content-height>
    <Card :title="$t('proto.settings.title')" :bordered="false">
      <Tabs v-model:active-key="activeKey">
        <TabPane
          v-for="tab in visibleTabs"
          :key="tab"
          :tab="tabLabels[tab]"
        >
          <!-- 只渲染当前 Tab，避免进入设置页就打全量接口 -->
          <AccountSecurity v-if="activeKey === 'security'" />
          <UserManage v-else-if="activeKey === 'user'" />
          <RoleManage v-else-if="activeKey === 'role'" />
          <MenuManage v-else-if="activeKey === 'menu'" />
          <LogManage v-else-if="activeKey === 'log'" />
        </TabPane>
      </Tabs>
    </Card>
  </Page>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { TabPane, Tabs } from 'ant-design-vue';

import { $t } from '#/locales';

import LoginLogTable from './LoginLogTable.vue';
import OperLogTable from './OperLogTable.vue';

defineOptions({ name: 'LogManage' });

/**
 * 日志 Tab（前端设计 §3.8）：登录日志与操作日志是两份数据源、两套筛选条件，
 * 各自独立成组件，这里只做切换，不混在一张表里。
 */
const activeKey = ref<'login' | 'oper'>('login');
</script>

<template>
  <div class="flex h-full flex-col">
    <Tabs v-model:active-key="activeKey" class="shrink-0">
      <TabPane key="login" :tab="$t('proto.log.tabs.login')" />
      <TabPane key="oper" :tab="$t('proto.log.tabs.oper')" />
    </Tabs>

    <!-- 只渲染当前一份：切走即卸载，避免两张表各自持有过期分页状态 -->
    <LoginLogTable v-if="activeKey === 'login'" class="min-h-0 flex-1" />
    <OperLogTable v-else class="min-h-0 flex-1" />
  </div>
</template>

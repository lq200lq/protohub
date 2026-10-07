<script setup lang="ts">
import { Page } from '@vben/common-ui';

import LogManage from '#/views/system/setting/components/LogManage.vue';

defineOptions({ name: 'SystemSettingLog' });
</script>

<template>
  <Page auto-content-height>
    <LogManage />
  </Page>
</template>

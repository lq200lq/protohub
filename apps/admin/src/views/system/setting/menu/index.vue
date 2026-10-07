<script setup lang="ts">
import { Page } from '@vben/common-ui';

import MenuManage from '#/views/system/setting/components/MenuManage.vue';

defineOptions({ name: 'SystemSettingMenu' });
</script>

<template>
  <Page auto-content-height>
    <MenuManage />
  </Page>
</template>

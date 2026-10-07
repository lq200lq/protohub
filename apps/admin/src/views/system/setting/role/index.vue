<script setup lang="ts">
import { Page } from '@vben/common-ui';

import RoleManage from '#/views/system/setting/components/RoleManage.vue';

defineOptions({ name: 'SystemSettingRole' });
</script>

<template>
  <Page auto-content-height>
    <RoleManage />
  </Page>
</template>

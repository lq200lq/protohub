<script setup lang="ts">
import { Page } from '@vben/common-ui';

import UserManage from '#/views/system/setting/components/UserManage.vue';

defineOptions({ name: 'SystemSettingUser' });
</script>

<template>
  <Page auto-content-height>
    <UserManage />
  </Page>
</template>

<script setup lang="ts">
import { Page } from '@vben/common-ui';

import AccountSecurity from '#/views/system/setting/components/AccountSecurity.vue';

defineOptions({ name: 'SystemSettingSecurity' });
</script>

<template>
  <Page auto-content-height>
    <AccountSecurity />
  </Page>
</template>

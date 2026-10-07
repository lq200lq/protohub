<script setup lang="ts">
import { Card } from 'ant-design-vue';

import { Page } from '@vben/common-ui';

import { $t } from '#/locales';

// 与「设置 → 账号安全」是同一份内容（前端设计 §3.8 / §4 两处都要求有），
// 组件只此一个实现，避免两份改密表单各自漂移。
import AccountSecurity from '#/views/system/setting/components/AccountSecurity.vue';

defineOptions({ name: 'Profile' });
</script>

<template>
  <Page auto-content-height>
    <Card
      :title="$t('proto.profile.title')"
      :bordered="false"
      :extra="$t('proto.profile.desc')"
    >
      <AccountSecurity />
    </Card>
  </Page>
</template>

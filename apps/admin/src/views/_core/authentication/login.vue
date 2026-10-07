<script lang="ts" setup>
import type { LoginParams } from '@protohub/shared';
import type { Recordable } from '@vben/types';
import type { VbenFormSchema } from '@vben/common-ui';

import { computed } from 'vue';

import { AuthenticationLogin, z } from '@vben/common-ui';
import { $t } from '@vben/locales';

import CopyText from '#/components/proto/CopyText.vue';
import { useAuthStore } from '#/store';

defineOptions({ name: 'Login' });

const authStore = useAuthStore();

// 仅开发环境渲染；口令由 scripts/reset-admin-password.mjs 重置，生产种子口令是随机的
const isDev = import.meta.env.DEV;
const DEV_ACCOUNT = { password: 'Admin-Dev-2026!', username: 'admin' };

/** AuthenticationLogin 的 submit 事件只给出泛化表单值（Recordable），这里收窄为后端契约的 LoginParams */
function handleSubmit(values: Recordable<unknown>) {
  const params: LoginParams = {
    password: String(values.password ?? ''),
    username: String(values.username ?? ''),
  };
  return authStore.authLogin(params);
}

const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'VbenInput',
      componentProps: {
        placeholder: $t('authentication.usernameTip'),
      },
      fieldName: 'username',
      label: $t('authentication.username'),
      rules: z.string().min(1, { message: $t('authentication.usernameTip') }),
    },
    {
      component: 'VbenInputPassword',
      componentProps: {
        placeholder: $t('authentication.password'),
      },
      fieldName: 'password',
      label: $t('authentication.password'),
      rules: z.string().min(1, { message: $t('authentication.passwordTip') }),
    },
  ];
});
</script>

<template>
  <div>
    <AuthenticationLogin
      :form-schema="formSchema"
      :loading="authStore.loginLoading"
      :show-code-login="false"
      :show-forget-password="false"
      :show-qrcode-login="false"
      :show-register="false"
      :show-third-party-login="false"
      @submit="handleSubmit"
    />
    <div
      v-if="isDev"
      class="border-border mt-6 rounded-md border border-dashed px-4 py-3"
    >
      <div class="text-muted-foreground mb-2 text-xs">
        {{ $t('proto.devLogin.label') }}
      </div>
      <div class="flex flex-wrap items-center gap-4">
        <span class="inline-flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">
            {{ $t('authentication.username') }}
          </span>
          <CopyText :max-width="0" :text="DEV_ACCOUNT.username" />
        </span>
        <span class="inline-flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">
            {{ $t('authentication.password') }}
          </span>
          <CopyText :max-width="0" :text="DEV_ACCOUNT.password" />
        </span>
      </div>
    </div>
  </div>
</template>

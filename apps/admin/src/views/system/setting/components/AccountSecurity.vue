<script setup lang="ts">
import type { UserInfo } from '@protohub/shared';
import type { VbenFormSchema } from '#/adapter/form';

import { computed, onMounted, ref } from 'vue';

import { Button, Card, message } from 'ant-design-vue';

import { formatDateTime } from '@vben/utils';

import { useVbenForm, z } from '#/adapter/form';
import { getProfileApi, getUserInfoApi, updateProfileApi } from '#/api';
import ChangePasswordForm from '#/components/auth/ChangePasswordForm.vue';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';

defineOptions({ name: 'AccountSecurity' });

interface ProfileFormValues {
  avatar?: string;
  email?: string;
  phone?: string;
  realName: string;
}

const authStore = useAuthStore();

const me = ref<null | UserInfo>(null);
const loadingProfile = ref(false);
const profileError = ref<null | string>(null);
const savingProfile = ref(false);
/** §3.8 要求显示上次登录时间与 IP；/user/info 没这两个字段，只能从 /user/profile 取 */
const lastLogin = ref<{ at: null | string; ip: null | string }>({
  at: null,
  ip: null,
});

const schema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'Input',
      fieldName: 'realName',
      label: $t('proto.account.fields.realName'),
      rules: z.string().min(1, { message: $t('proto.account.fields.realName') }),
    },
    {
      component: 'Input',
      fieldName: 'email',
      label: $t('proto.account.fields.email'),
      rules: z.string().refine(
        (value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        { message: $t('proto.account.emailInvalid') },
      ),
    },
    {
      component: 'Input',
      fieldName: 'phone',
      label: $t('proto.account.fields.phone'),
    },
    {
      component: 'Input',
      fieldName: 'avatar',
      label: $t('proto.account.fields.avatar'),
    },
    {
      component: 'Input',
      componentProps: { disabled: true },
      fieldName: 'username',
      label: $t('proto.account.fields.username'),
    },
  ];
});

const [ProfileForm, profileFormApi] = useVbenForm({
  schema: schema.value,
  showDefaultActions: false,
  commonConfig: { labelWidth: 130 },
  wrapperClass: 'grid-cols-1',
});

async function loadProfile() {
  loadingProfile.value = true;
  profileError.value = null;
  try {
    const [info, detail] = await Promise.all([
      getUserInfoApi(),
      getProfileApi(),
    ]);
    me.value = info;
    lastLogin.value = { at: detail.lastLoginAt, ip: detail.lastLoginIp };
    await profileFormApi.setValues({
      avatar: me.value.avatar ?? '',
      email: me.value.email ?? '',
      phone: me.value.phone ?? '',
      realName: me.value.realName,
      username: me.value.username,
    });
  } catch (error) {
    profileError.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    loadingProfile.value = false;
  }
}

onMounted(loadProfile);

async function handleSaveProfile() {
  const { valid } = await profileFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await profileFormApi.getValues<ProfileFormValues>();
  savingProfile.value = true;
  try {
    await updateProfileApi({
      avatar: values.avatar || undefined,
      email: values.email || undefined,
      phone: values.phone || undefined,
      realName: values.realName,
    });
    // 重新拉取，让姓名/头像在全局（下拉、水印）与 forcePasswordChange 等派生字段保持一致
    await authStore.fetchUserInfo();
    message.success($t('proto.account.profileUpdated'));
  } finally {
    savingProfile.value = false;
  }
}

async function handlePasswordChanged() {
  message.success($t('proto.account.passwordChanged'));
  // §2.8：改密后 token_version+1 且服务端清 Cookie，当前会话必然失效
  await authStore.logout(false);
}
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-2">
    <Card size="small" :title="$t('proto.account.profileTitle')">
      <DataState
        :loading="loadingProfile && !me"
        :error="profileError"
        @retry="loadProfile"
      >
        <p class="text-muted-foreground mb-1 text-sm">
          {{ $t('proto.account.profileDesc') }}
        </p>
        <p class="text-muted-foreground mb-3 text-xs">
          {{ $t('proto.account.lastLogin') }}：
          {{ formatDateTime(lastLogin.at ?? undefined) || $t('proto.account.neverLoggedIn') }}
          <template v-if="lastLogin.ip"> · {{ lastLogin.ip }}</template>
        </p>
        <ProfileForm />
        <div class="mt-2 flex justify-end">
          <Button
            type="primary"
            :loading="savingProfile"
            @click="handleSaveProfile"
          >
            {{ $t('proto.common.save') }}
          </Button>
        </div>
      </DataState>
    </Card>

    <Card size="small" :title="$t('proto.account.passwordTitle')">
      <ChangePasswordForm @success="handlePasswordChanged" />
    </Card>
  </div>
</template>

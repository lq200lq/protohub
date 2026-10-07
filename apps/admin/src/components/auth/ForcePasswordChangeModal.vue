<script setup lang="ts">
import { computed, watch } from 'vue';

import { useVbenModal } from '@vben/common-ui';
import { useUserStore } from '@vben/stores';

import { Button, message } from 'ant-design-vue';

import { $t } from '#/locales';
import { useAuthStore } from '#/store';
import { hasForcePasswordChange } from '#/utils/user-info';

import ChangePasswordForm from './ChangePasswordForm.vue';

defineOptions({ name: 'ForcePasswordChangeModal' });

const userStore = useUserStore();
const authStore = useAuthStore();

const needChange = computed(() => hasForcePasswordChange(userStore.userInfo));

const [Modal, modalApi] = useVbenModal({
  // 强制改密：不可关闭、不可点遮罩，唯一出口是改密或退出登录
  closable: false,
  closeOnClickModal: false,
  closeOnPressEscape: false,
  footer: false,
  title: $t('proto.account.forceTitle'),
});

watch(
  needChange,
  (need) => {
    need ? modalApi.open() : modalApi.close();
  },
  { immediate: true },
);

async function handleChangeSuccess() {
  // §2.8：改密后 token_version+1 且服务端清 Cookie，当前会话必然失效
  message.success($t('proto.account.passwordChanged'));
  modalApi.close();
  await authStore.logout(false);
}

async function handleLogout() {
  modalApi.close();
  await authStore.logout(false);
}
</script>

<template>
  <Modal>
    <div class="py-2">
      <p class="text-muted-foreground mb-2">
        {{ $t('proto.account.forceDesc') }}
      </p>
      <ChangePasswordForm @success="handleChangeSuccess" />
      <div class="mt-3 flex justify-center">
        <Button size="small" type="link" @click="handleLogout">
          {{ $t('proto.account.logout') }}
        </Button>
      </div>
    </div>
  </Modal>
</template>

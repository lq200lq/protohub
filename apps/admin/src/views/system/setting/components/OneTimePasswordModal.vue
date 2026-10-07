<script setup lang="ts">
/**
 * 一次性密码展示弹窗（后端接口设计 §7.1.2 / §7.1.6）：
 * 创建用户的 initialPassword 与重置的 newPassword 都只在响应里返回一次，
 * 两种来源共用这一个组件，靠 setData 的 kind 区分文案。
 * 关闭被"我已抄录"卡住：没抄走就关掉，密码就永久丢了（一期没有邮件通道）。
 */
import { ref } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { Button, Checkbox, TypographyParagraph } from 'ant-design-vue';

import { $t } from '#/locales';

import type { OneTimePasswordPayload } from '../types';

defineOptions({ name: 'OneTimePasswordModal' });

const password = ref('');
const username = ref('');
const acknowledged = ref(false);
const revealed = ref(false);

const [Modal, modalApi] = useVbenModal({
  closable: false,
  footer: false,
  onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const data = modalApi.getData<OneTimePasswordPayload>();
    password.value = data?.password ?? '';
    username.value = data?.username ?? '';
    acknowledged.value = false;
    revealed.value = false;
    modalApi.setState({
      title:
        data?.kind === 'reset'
          ? $t('proto.user.passwordResult.resetTitle')
          : $t('proto.user.passwordResult.createdTitle'),
    });
  },
});

function handleClose() {
  modalApi.close();
}
</script>

<template>
  <Modal>
    <div class="space-y-3 py-1">
      <p class="text-muted-foreground text-sm">
        {{ $t('proto.user.fields.username') }}：{{ username }}
      </p>

      <TypographyParagraph
        class="!mb-0 font-mono text-base"
        :copyable="{
          text: password,
          tooltip: true,
        }"
      >
        {{ revealed ? password : '••••••••••' }}
      </TypographyParagraph>

      <div>
        <Button size="small" type="link" @click="revealed = !revealed">
          {{
            revealed
              ? $t('proto.user.passwordResult.hide')
              : $t('proto.user.passwordResult.reveal')
          }}
        </Button>
      </div>

      <p class="text-muted-foreground text-sm">
        {{ $t('proto.user.passwordResult.copyTip') }}
      </p>

      <div class="flex items-center justify-between pt-1">
        <Checkbox v-model:checked="acknowledged">
          {{ $t('proto.user.passwordResult.ack') }}
        </Checkbox>
        <Button :disabled="!acknowledged" type="primary" @click="handleClose">
          {{ $t('proto.user.passwordResult.ack') }}
        </Button>
      </div>
    </div>
  </Modal>
</template>

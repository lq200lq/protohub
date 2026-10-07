<script setup lang="ts">
import { IconifyIcon } from '@vben/icons';

import { useClipboard } from '@vueuse/core';
import { Button, Tooltip, message } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'CopyText' });

const props = withDefaults(
  defineProps<{
    /** 被复制的值：访问地址等一律来自服务端字段，前端不拼接域名 */
    text: string;
    /** 显示截断宽度（px）；0 表示不截断 */
    maxWidth?: number;
  }>(),
  { maxWidth: 320 },
);

const { copy } = useClipboard({ legacy: true });

async function onCopy() {
  try {
    await copy(props.text);
    message.success($t('proto.common.copySuccess'));
  } catch {
    // legacy 降级仍可能失败（非安全上下文）：给出可执行的补救提示而不是静默
    message.error($t('proto.common.copyFailed'));
  }
}
</script>

<template>
  <span class="inline-flex max-w-full items-center gap-1 align-middle">
    <Tooltip :title="text">
      <span
        class="truncate font-mono text-[13px]"
        :style="maxWidth > 0 ? { maxWidth: `${maxWidth}px` } : undefined"
      >
        {{ text }}
      </span>
    </Tooltip>
    <Button
      v-if="text"
      size="small"
      type="text"
      @click="onCopy"
    >
      <template #icon>
        <IconifyIcon icon="lucide:copy" class="size-3.5" />
      </template>
    </Button>
  </span>
</template>

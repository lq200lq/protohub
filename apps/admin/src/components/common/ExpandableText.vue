<script setup lang="ts">
import { computed, ref } from 'vue';

import { Button } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'ExpandableText' });

/**
 * 详情页长文本（前端设计 §10.2「长文本」：超长用展开/收起；列表里则干脆不显示这段文字）。
 *
 * "超长"按**字符数**判而不是数像素：像素判定受字号/容器宽度影响，界面一改阈值就漂；
 * 字符判定稳定、可测，也和输入侧的长度上限（描述 ≤200 字）对得上。
 * 项目详情与原型详情两处的说明文字共用这一份（§3.7「两处以上收敛」）。
 */
const props = defineProps<{
  /** 阈值内的文本原样显示，不给按钮 */
  threshold?: number;
  text: null | string;
}>();

const DEFAULT_THRESHOLD = 120;

const expanded = ref(false);
const limit = computed(() => props.threshold ?? DEFAULT_THRESHOLD);
const isLong = computed(() => (props.text ?? '').length > limit.value);
const shown = computed(() => {
  const value = props.text ?? '';
  if (value.length === 0) return '';
  return isLong.value && !expanded.value ? `${value.slice(0, limit.value)}…` : value;
});
</script>

<template>
  <div>
    <p class="break-words whitespace-pre-wrap">{{ shown || '—' }}</p>
    <Button
      v-if="isLong"
      class="px-0"
      size="small"
      type="link"
      @click="expanded = !expanded"
    >
      {{ expanded ? $t('proto.common.collapse') : $t('proto.common.expand') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import type { ProjectStatus, PrototypeStatus } from '@protohub/shared';

import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'ProtoStatusTag' });

/** 同一套取值服务项目与原型两级（迭代实施计划 M2-T5）；status 是服务端派生值，前端不再判断一遍 */
const props = defineProps<{
  status: null | ProjectStatus | PrototypeStatus | undefined;
}>();

const COLOR_TOKENS: Record<string, string> = {
  archived: 'default',
  draft: 'orange',
  published: 'green',
};

const label = computed(() => {
  switch (props.status) {
    case 'archived': {
      return $t('proto.common.statuses.archived');
    }
    case 'draft': {
      return $t('proto.common.statuses.draft');
    }
    case 'published': {
      return $t('proto.common.statuses.published');
    }
    default: {
      return '—';
    }
  }
});

const color = computed(() =>
  props.status ? (COLOR_TOKENS[props.status] ?? 'default') : 'default',
);
</script>

<template>
  <Tag :color="color">{{ label }}</Tag>
</template>

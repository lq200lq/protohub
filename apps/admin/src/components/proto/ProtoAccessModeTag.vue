<script setup lang="ts">
import type { AccessMode } from '@protohub/shared';

import { computed } from 'vue';

import { Tag } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'ProtoAccessModeTag' });

const props = defineProps<{
  mode: null | AccessMode | undefined;
}>();

const COLOR_TOKENS: Record<string, string> = {
  member: 'cyan',
  password: 'purple',
  public: 'blue',
};

const label = computed(() => {
  switch (props.mode) {
    case 'member': {
      return $t('proto.common.accessModes.member');
    }
    case 'password': {
      return $t('proto.common.accessModes.password');
    }
    case 'public': {
      return $t('proto.common.accessModes.public');
    }
    default: {
      return '—';
    }
  }
});

const color = computed(() =>
  props.mode ? (COLOR_TOKENS[props.mode] ?? 'default') : 'default',
);
</script>

<template>
  <Tag :color="color">{{ label }}</Tag>
</template>

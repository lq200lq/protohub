<script setup lang="ts">
import { Button, Empty, Spin } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'DataState' });

defineProps<{
  empty?: boolean;
  emptyText?: string;
  error?: null | string;
  loading?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="loading" class="flex min-h-40 items-center justify-center py-8">
    <Spin />
  </div>
  <div
    v-else-if="error"
    class="flex min-h-40 flex-col items-center justify-center gap-3 py-8"
  >
    <p>{{ $t('proto.common.loadFailed') }}</p>
    <p class="text-muted-foreground text-sm">{{ error }}</p>
    <Button size="small" @click="emit('retry')">
      {{ $t('proto.common.retry') }}
    </Button>
  </div>
  <Empty
    v-else-if="empty"
    :description="emptyText ?? $t('proto.common.empty')"
    class="py-12"
  />
  <slot v-else></slot>
</template>

<script setup lang="ts">
import { Card } from 'ant-design-vue';

defineOptions({ name: 'StatCard' });

/**
 * 统计卡基础件（前端设计 §6：两处以上用到的能力收敛为一个通用组件）。
 * 工作台 4 卡与访问记录 5 卡是同一副骨架（标签 / 主值 / 次级小字），
 * 业务差异全在 props；测试钩子也走 props，基础件不认任何业务 testid。
 */
defineProps<{
  cardTestId?: string;
  label: string;
  loading?: boolean;
  sub?: null | string;
  testId?: string;
  value: number | string;
}>();
</script>

<template>
  <Card :bordered="false" :loading="loading" size="small">
    <div :data-testid="cardTestId">
      <p class="text-xs text-muted-foreground">{{ label }}</p>
      <p :data-testid="testId" class="mt-1 text-xl font-semibold">
        {{ value }}
      </p>
      <p v-if="sub" class="mt-1 text-xs text-muted-foreground">{{ sub }}</p>
    </div>
  </Card>
</template>

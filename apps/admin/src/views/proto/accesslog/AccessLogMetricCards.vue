<script setup lang="ts">
import type { AccessLogSummary } from '@protohub/shared';

import { computed } from 'vue';

import StatCard from '#/components/common/StatCard.vue';
import { $t } from '#/locales';

import { summaryMetricCards } from './accesslog-view';

defineOptions({ name: 'AccessLogMetricCards' });

/**
 * 概览 5 指标（前端设计 §3.7）：PV / UV / 被拒次数 / 爬虫请求 / 无效链接访问。
 * 取数一律直读 GET /api/access-logs/summary 的字段（§6.2），前端不做任何二次加工、
 * 不再补解释文案——口径（UV 按 date+ip+ua 去重、invalidPv 只算编码不存在/已删）只在服务端一处。
 * 卡片骨架走 `StatCard`（与工作台 4 卡同一副骨架，前端设计 §6）。
 */
const props = defineProps<{
  loading?: boolean;
  summary: AccessLogSummary | null;
}>();

const cards = computed(() =>
  props.summary === null ? [] : summaryMetricCards(props.summary),
);
</script>

<template>
  <div
    class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
    data-testid="accesslog-metrics"
  >
    <StatCard
      v-for="card in cards"
      :key="card.key"
      card-test-id="accesslog-metric-card-value"
      :label="$t(card.labelKey)"
      :loading="props.loading"
      :test-id="`accesslog-metric-${card.key}`"
      :value="card.value"
    />
  </div>
</template>

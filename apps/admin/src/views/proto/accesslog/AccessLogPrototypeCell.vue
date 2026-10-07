<script setup lang="ts">
import type { AccessLogItem } from '@protohub/shared';

import { computed } from 'vue';

import { $t } from '#/locales';

import { prototypeCellOf } from './accesslog-view';

defineOptions({ name: 'AccessLogPrototypeCell' });

/**
 * 明细表「原型」列的单元格（前端设计 §3.7 / 迭代实施计划 M4-T11 判据）：
 * `prototypeName` 为空且还有 `routeKey`（编码不存在或原型已删）时显示灰色「无效链接」，
 * 副标题用 `routeKey` 说明访问的到底是哪条路径——这一列的存在让"删了原型还有人访问"一眼可见。
 * 判定在 accesslog-view 的 prototypeCellOf（纯函数，单测直接断言），这里只负责呈现。
 */
const props = defineProps<{ row: AccessLogItem }>();

const cell = computed(() => prototypeCellOf(props.row));
</script>

<template>
  <div
    v-if="cell.invalid"
    class="leading-tight"
    data-testid="accesslog-invalid-cell"
  >
    <span class="text-muted-foreground">{{ $t('proto.accesslog.invalidLink') }}</span>
    <div
      class="font-mono text-xs text-muted-foreground"
      data-testid="accesslog-invalid-route-key"
    >
      {{ cell.routeKey }}
    </div>
  </div>
  <span v-else-if="cell.title">{{ cell.title }}</span>
  <span v-else class="text-muted-foreground">—</span>
</template>

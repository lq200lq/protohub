<script setup lang="ts">
import type { ReleaseEventType } from '@protohub/shared';

import { formatDateTime } from '@vben/utils';

import { Tag, Timeline, TimelineItem } from 'ant-design-vue';

import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';

defineOptions({ name: 'ReleaseEventTimeline' });

/**
 * 版本事件时间线——「带原型名、无操作按钮」的那一型（前端设计 §3.1 最近动态、§3.3 项目动态；
 * 偏差 DEV-26 第 4 点约定与工作台一起落地，两个消费者共用这一份呈现）。
 *
 * 与 `ReleaseTimeline`（原型详情那个容器）不同型：那边按 `prototypeId` 自取数、要回滚按钮，
 * 这里只画事件流本身。两个数据源的字段正好互补，取并集：
 * 项目事件（`GET /api/projects/{id}/events`）带 from/to 版本号但不带 `projectName`（项目已知），
 * 工作台 overview 的 `recentEvents` 带 `projectName` 而契约里没有那两列。
 * 有就渲染，没有就不渲染——组件不为缺的列编数字。
 */
export interface ActivityEvent {
  createdAt: string;
  eventType: ReleaseEventType;
  fromVersionNo?: null | number;
  id: string;
  operatorName: string;
  projectName?: string;
  prototypeCode: string;
  prototypeName: string;
  reason: null | string;
  toVersionNo?: null | number;
}

const props = defineProps<{
  emptyText?: string;
  error?: null | string;
  events: ActivityEvent[];
  loading?: boolean;
}>();

const emit = defineEmits<{ retry: [] }>();

/** 五种事件类型各说各的（后端接口设计 §4.5：publish/rollback/republish/unpublish/delete_version） */
const ACTION_LABEL_KEYS: Record<ReleaseEventType, string> = {
  delete_version: 'proto.release.eventTypes.delete',
  publish: 'proto.release.eventTypes.publish',
  republish: 'proto.release.eventTypes.republish',
  rollback: 'proto.release.eventTypes.rollback',
  unpublish: 'proto.release.eventTypes.unpublish',
};

const TAG_COLORS: Record<ReleaseEventType, string> = {
  delete_version: 'red',
  publish: 'blue',
  republish: 'blue',
  rollback: 'orange',
  unpublish: 'gray',
};

function tagColor(eventType: ReleaseEventType): string {
  return TAG_COLORS[eventType];
}

function actionLabel(eventType: ReleaseEventType): string {
  return $t(ACTION_LABEL_KEYS[eventType]);
}

/** 回滚/删除版本才有"从哪到哪"，工作台那条数据源没这两列时只说动作 */
function detailText(event: ActivityEvent): null | string {
  const from = event.fromVersionNo ?? null;
  const to = event.toVersionNo ?? null;
  if (event.eventType === 'rollback') {
    return from === null && to === null
      ? null
      : $t('proto.release.rollback.fromTo', [from ?? '—', to ?? '—']);
  }
  if (event.eventType === 'delete_version') {
    return from === null ? null : $t('proto.release.deletedVersion.of', [from]);
  }
  return null;
}
</script>

<template>
  <DataState
    :empty="props.events.length === 0"
    :empty-text="props.emptyText ?? $t('proto.release.eventTimelineEmpty')"
    :error="props.error"
    :loading="props.loading"
    @retry="emit('retry')"
  >
    <Timeline class="pt-1">
      <TimelineItem
        v-for="event in props.events"
        :key="event.id"
        :color="tagColor(event.eventType)"
      >
        <div class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <Tag :color="tagColor(event.eventType)">
              {{ actionLabel(event.eventType) }}
            </Tag>
            <span class="text-sm font-semibold">{{ event.prototypeName }}</span>
            <span
              v-if="event.projectName"
              class="text-muted-foreground text-xs"
            >
              {{ event.projectName }}
            </span>
          </div>
          <p v-if="detailText(event)" class="text-sm">{{ detailText(event) }}</p>
          <p class="text-muted-foreground text-xs">
            {{ event.operatorName }} · {{ formatDateTime(event.createdAt) }}
          </p>
          <p v-if="event.reason" class="text-muted-foreground text-xs">
            {{ $t('proto.release.versionNote') }}：{{ event.reason }}
          </p>
        </div>
      </TimelineItem>
    </Timeline>
  </DataState>
</template>

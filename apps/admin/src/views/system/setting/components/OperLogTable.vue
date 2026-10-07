<script setup lang="ts">
import type { OperLogItem } from '@protohub/shared';

import { computed, ref } from 'vue';

import { formatDateTime } from '@vben/utils';

import { Alert, Button, Tag, Tooltip, Typography } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getOperLogsApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

defineOptions({ name: 'OperLogTable' });

/**
 * 操作日志（后端接口设计 §7.5.2）。
 * detail 是服务端已脱敏的变更差异，只在悬浮里展开看，不在列表里铺开
 * （前端设计 §10.1：列表只放判断所需字段）。
 */
const loadError = ref<null | string>(null);

/** useVbenVxeGrid 不给 query 回调上下文类型，这里显式标注代理参数（vxe 分页上下文 + 筛选表单值） */
interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
}
interface OperLoginFormValues {
  action?: string;
  dateRange?: string[];
  resourceType?: string;
  username?: string;
}

const resourceTypeOptions = computed(() =>
  ['project', 'prototype', 'release', 'user', 'role', 'menu'].map((value) => ({
    label: $t(`proto.log.filter.resourceType.options.${value}`),
    value,
  })),
);

const [Grid, gridApi] = useVbenVxeGrid<OperLogItem>({
  formOptions: {
    schema: [
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.log.filter.usernamePlaceholder'),
        },
        fieldName: 'username',
        label: $t('proto.log.operColumns.username'),
      },
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.log.filter.actionPlaceholder'),
        },
        fieldName: 'action',
        label: $t('proto.log.operColumns.action'),
      },
      {
        component: 'Select',
        componentProps: { allowClear: true, options: resourceTypeOptions.value },
        fieldName: 'resourceType',
        label: $t('proto.log.filter.resourceType.label'),
      },
      {
        component: 'RangePicker',
        componentProps: { showTime: true, valueFormat: 'YYYY-MM-DD HH:mm:ss' },
        fieldName: 'dateRange',
        label: $t('proto.log.filter.dateRange'),
      },
    ],
    submitOnChange: true,
    wrapperClass: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
  },
  gridOptions: {
    columns: [
      {
        field: 'createdAt',
        minWidth: 165,
        slots: { default: 'createdAt' },
        title: $t('proto.log.operColumns.createdAt'),
      },
      {
        field: 'username',
        minWidth: 110,
        slots: { default: 'username' },
        title: $t('proto.log.operColumns.username'),
      },
      {
        field: 'module',
        title: $t('proto.log.operColumns.module'),
        width: 100,
      },
      {
        field: 'action',
        minWidth: 120,
        title: $t('proto.log.operColumns.action'),
      },
      {
        field: 'resource',
        minWidth: 170,
        slots: { default: 'resource' },
        title: $t('proto.log.operColumns.resource'),
      },
      {
        field: 'path',
        minWidth: 200,
        slots: { default: 'path' },
        title: $t('proto.log.operColumns.path'),
      },
      {
        field: 'ip',
        minWidth: 120,
        title: $t('proto.log.operColumns.ip'),
      },
      {
        field: 'durationMs',
        slots: { default: 'durationMs' },
        title: $t('proto.log.operColumns.duration'),
        width: 90,
      },
      {
        field: 'success',
        slots: { default: 'success' },
        title: $t('proto.log.result.success'),
        width: 90,
      },
      {
        field: 'detail',
        slots: { default: 'detail' },
        title: $t('proto.common.more'),
        width: 80,
      },
    ],
    height: 'auto',
    proxyConfig: {
      ajax: {
        query: async (
          { page }: ProxyQueryArgs,
          formValues: null | OperLoginFormValues | undefined,
        ) => {
          try {
            const [startTime, endTime] = formValues?.dateRange ?? [];
            const result = await getOperLogsApi({
              action: formValues?.action || undefined,
              endTime,
              page: page.currentPage,
              pageSize: page.pageSize,
              resourceType: formValues?.resourceType || undefined,
              startTime,
              username: formValues?.username || undefined,
            });
            loadError.value = null;
            return result;
          } catch (error) {
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true },
  },
});

function formatDetail(detail: null | Record<string, unknown>) {
  return detail ? JSON.stringify(detail, null, 2) : '';
}
</script>

<template>
  <div class="flex h-full flex-col gap-2">
    <Alert v-if="loadError" :message="loadError" banner type="error">
      <template #action>
        <Button size="small" @click="gridApi.query()">
          {{ $t('proto.common.retry') }}
        </Button>
      </template>
    </Alert>

    <Grid class="min-h-0 flex-1">
      <template #createdAt="{ row }">
        <span class="text-muted-foreground text-[13px]">{{ formatDateTime(row.createdAt) }}</span>
      </template>

      <template #username="{ row }">
        <span class="font-semibold">{{ row.username ?? '—' }}</span>
      </template>

      <template #resource="{ row }">
        <span class="text-[13px]">{{ row.resourceName ?? '—' }}</span>
        <span
          v-if="row.resourceType"
          class="text-muted-foreground ml-1 font-mono text-xs"
        >
          {{ row.resourceType }}
        </span>
      </template>

      <!-- L4：接口路径等元数据用等宽 + 次级色 -->
      <template #path="{ row }">
        <span class="text-muted-foreground font-mono text-[13px]">
          {{ row.method ?? '' }} {{ row.path ?? '—' }}
        </span>
      </template>

      <template #durationMs="{ row }">
        <span class="text-[13px]">
          {{ row.durationMs === null ? '—' : `${row.durationMs} ms` }}
        </span>
      </template>

      <template #success="{ row }">
        <Tag :color="row.success ? 'green' : 'red'">
          {{
            row.success
              ? $t('proto.log.result.success')
              : $t('proto.log.result.fail')
          }}
        </Tag>
        <Tooltip v-if="row.errorMessage" :title="row.errorMessage">
          <Typography.Text class="text-xs">?</Typography.Text>
        </Tooltip>
      </template>

      <template #detail="{ row }">
        <Tooltip
          v-if="row.detail"
          :title="formatDetail(row.detail)"
          overlay-class-name="max-w-lg"
        >
          <Button size="small" type="link">
            {{ $t('proto.common.more') }}
          </Button>
        </Tooltip>
        <span v-else class="text-muted-foreground">—</span>
      </template>
    </Grid>
  </div>
</template>

<script setup lang="ts">
import type { LoginLogItem } from '@protohub/shared';

import { ref } from 'vue';

import { formatDateTime } from '@vben/utils';

import { Alert, Button, Tag } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getLoginLogsApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

defineOptions({ name: 'LoginLogTable' });

/** 登录日志（后端接口设计 §7.5.1）：筛选 username / success / 时间范围 */
const loadError = ref<null | string>(null);

/** useVbenVxeGrid 不给 query 回调上下文类型，这里显式标注代理参数（vxe 分页上下文 + 筛选表单值） */
interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
}
interface LoginFormValues {
  dateRange?: string[];
  success?: boolean;
  username?: string;
}

const [Grid, gridApi] = useVbenVxeGrid<LoginLogItem>({
  formOptions: {
    schema: [
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.log.filter.usernamePlaceholder'),
        },
        fieldName: 'username',
        label: $t('proto.log.loginColumns.username'),
      },
      {
        component: 'Select',
        componentProps: {
          allowClear: true,
          options: [
            { label: $t('proto.log.result.success'), value: true },
            { label: $t('proto.log.result.fail'), value: false },
          ],
        },
        fieldName: 'success',
        label: $t('proto.log.loginColumns.success'),
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
        title: $t('proto.log.loginColumns.createdAt'),
      },
      {
        field: 'username',
        minWidth: 120,
        slots: { default: 'username' },
        title: $t('proto.log.loginColumns.username'),
      },
      {
        field: 'loginType',
        slots: { default: 'loginType' },
        title: $t('proto.log.loginColumns.loginType'),
        width: 100,
      },
      {
        field: 'ip',
        minWidth: 130,
        title: $t('proto.log.loginColumns.ip'),
      },
      {
        field: 'success',
        slots: { default: 'success' },
        title: $t('proto.log.loginColumns.success'),
        width: 90,
      },
      {
        field: 'failReason',
        minWidth: 160,
        title: $t('proto.log.loginColumns.failReason'),
      },
      {
        field: 'userAgent',
        minWidth: 200,
        title: $t('proto.log.loginColumns.userAgent'),
      },
    ],
    height: 'auto',
    proxyConfig: {
      ajax: {
        query: async (
          { page }: ProxyQueryArgs,
          formValues: null | LoginFormValues | undefined,
        ) => {
          try {
            const [startTime, endTime] = formValues?.dateRange ?? [];
            const result = await getLoginLogsApi({
              endTime,
              page: page.currentPage,
              pageSize: page.pageSize,
              startTime,
              success: formValues?.success,
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
      <!-- L4：时间是次级信息 -->
      <template #createdAt="{ row }">
        <span class="text-muted-foreground text-[13px]">{{ formatDateTime(row.createdAt) }}</span>
      </template>

      <template #username="{ row }">
        <span class="font-semibold">{{ row.username }}</span>
      </template>

      <template #loginType="{ row }">
        {{ $t(`proto.log.loginTypes.${row.loginType}`) }}
      </template>

      <template #success="{ row }">
        <Tag :color="row.success ? 'green' : 'red'">
          {{
            row.success
              ? $t('proto.log.result.success')
              : $t('proto.log.result.fail')
          }}
        </Tag>
      </template>
    </Grid>
  </div>
</template>

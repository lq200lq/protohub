<script setup lang="ts">
import type { AccessLogItem } from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { formatDateTime } from '@vben/utils';

import { Button, Tag } from 'ant-design-vue';
import { useRouter } from 'vue-router';

import { getAccessLogsApi } from '#/api';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';
import {
  ACCESS_LOG_PANEL_LIMIT,
  ACCESS_LOG_ROUTE_PATH,
  buildAccessLogJumpQuery,
  buildListQuery,
  toAccessLogPanelRows,
} from '#/views/proto/accesslog/accesslog-view';
import { toErrorMessage } from '#/utils/error';

defineOptions({ name: 'PrototypeAccessLogPanel' });

/**
 * 原型详情「访问记录」折叠区（前端设计 §3.5「该原型最近 20 条入口访问；更多跳访问记录页」；
 * 迭代实施计划 M4-T12）。§6.1 没有"只取入口"这一维，§3.5 那句按 DEV-36 收成"最近 20 条访问"，
 * 于是资源级 404/403 也会进这里——那正是白屏那一类的线索。
 *
 * 展开那一帧才取数：父页把 Collapse 的 activeKey 折成 `enabled` 递下来，面板首次为真才发
 * 一次 `GET /api/access-logs?prototypeId&pageSize=20`；收起再展开不重复请求（`loadedFor` 记着
 * 是哪个原型取过），失败态下 `loadedFor` 不置位，于是重试按钮或再次展开都会重新发起。
 *
 * 呈现判定全部走 accesslog-view（与访问记录明细表同一套：结果 Tag、浏览器/系统/设备、时间拆行、
 * IP 直读服务端打码值）——这里不重算第二套，否则同一行在两页给出两种结论。
 *
 * 「没权限」不在这层判：§10.2 规定页面内区块**整块隐藏**而不是显示"无权限"占位，
 * 所以那道判断在父页（整个折叠区挂不挂出来），这里只管取数与三态。
 */
const props = defineProps<{ enabled: boolean; prototypeId: string }>();

const router = useRouter();

const items = ref<AccessLogItem[]>([]);
const loading = ref(false);
const error = ref<null | string>(null);

let loadedFor = '';
let seq = 0;

async function load() {
  const prototypeId = props.prototypeId;
  if (!prototypeId) {
    return;
  }
  const current = (seq += 1);
  loading.value = true;
  error.value = null;
  try {
    const result = await getAccessLogsApi(
      buildListQuery({ prototypeId }, { pageNumber: 1, pageSize: ACCESS_LOG_PANEL_LIMIT }),
    );
    if (current !== seq) return; // 换原型/重进后更晚的那次请求才说了算
    items.value = result.items;
    loadedFor = prototypeId;
  } catch (caught) {
    if (current !== seq) return;
    // 失败要看得见：不静默落空白，交 DataState 呈现服务端可读文案 + 重试
    error.value = toErrorMessage(caught) || $t('proto.common.loadFailed');
  } finally {
    if (current === seq) loading.value = false;
  }
}

// immediate：antd 折叠面板首次展开才挂载内容，此刻 enabled 已是真；也兼容"挂载时先关后开"
watch(
  () => [props.enabled, props.prototypeId] as const,
  ([enabled, prototypeId]) => {
    if (!enabled || !prototypeId) return;
    if (loadedFor === prototypeId) return;
    void load();
  },
  { immediate: true },
);

const rows = computed(() =>
  toAccessLogPanelRows(items.value, {
    formatTime: (value) => formatDateTime(value),
    translate: (key) => $t(key),
  }),
);

const isEmpty = computed(() => !loading.value && error.value === null && rows.value.length === 0);

function onMore() {
  router.push({
    path: ACCESS_LOG_ROUTE_PATH,
    query: buildAccessLogJumpQuery({ prototypeId: props.prototypeId }),
  });
}
</script>

<template>
  <DataState
    :empty="isEmpty"
    :empty-text="$t('proto.prototype.emptyHints.accessLog')"
    :error="error"
    :loading="loading"
    @retry="load"
  >
    <div class="flex flex-col">
      <div class="mb-1 flex items-center justify-between gap-2">
        <span class="text-muted-foreground text-xs">
          {{ $t('proto.prototype.accessLog.hint', [ACCESS_LOG_PANEL_LIMIT]) }}
        </span>
        <Button class="px-0" size="small" type="link" @click="onMore">
          {{ $t('proto.prototype.accessLog.more') }}
        </Button>
      </div>
      <div
        v-for="row in rows"
        :key="row.id"
        class="border-b border-border py-2 last:border-b-0"
        data-testid="prototype-accesslog-row"
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-muted-foreground shrink-0 font-mono text-xs">
            {{ row.time.date }} {{ row.time.time }}
          </span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ row.path }}</span>
          <Tag :color="row.result.color">{{ $t(row.result.labelKey) }}</Tag>
        </div>
        <div class="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 text-xs">
          <span>{{ row.visitorName ?? $t('proto.accesslog.anonymous') }}</span>
          <span class="font-mono">{{ row.ip ?? '—' }}</span>
          <span>{{ row.browser ?? '—' }}</span>
          <span v-if="row.envSub">{{ row.envSub }}</span>
        </div>
      </div>
    </div>
  </DataState>
</template>

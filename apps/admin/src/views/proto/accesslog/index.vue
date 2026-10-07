<script setup lang="ts">
import type { RadioChangeEvent } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';
import type {
  AccessLogItem,
  AccessLogResult,
  AccessLogSummary,
  PrototypeListItem,
} from '@protohub/shared';
import type { EchartsUIType } from '@vben/plugins/echarts';

import type {
  AccessLogScope,
  AccessLogTimePreset,
  AppliedAccessLogFilters,
} from './accesslog-view';

import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { Fallback, Page } from '@vben/common-ui';
import { EchartsUI, useEcharts } from '@vben/plugins/echarts';
import { formatDateTime } from '@vben/utils';
import { ACCESS_LOG_RESULTS } from '@protohub/shared';

import { Button, Card, DatePicker, Input, RadioGroup, Select, Tag, Alert } from 'ant-design-vue';
import { useRoute } from 'vue-router';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import {
  getAccessLogsApi,
  getAccessLogSummaryApi,
  getProjectDetailApi,
  getPrototypeDetailApi,
} from '#/api';
import PrototypePicker from '#/components/proto/PrototypePicker.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

import AccessLogMetricCards from './AccessLogMetricCards.vue';
import AccessLogPrototypeCell from './AccessLogPrototypeCell.vue';
import {
  accessLogEnvSubText,
  accessLogScopeEquals,
  buildListQuery,
  buildSummaryQuery,
  buildTrendOption,
  initialScopeFromQuery,
  isAccessLogResult,
  isAccessLogTimePreset,
  resolveTimeWindow,
  resultTagOf,
  splitDateTime,
} from './accesslog-view';

defineOptions({ name: 'ProtoAccessLog' });

/**
 * 访问记录页（前端设计 §3.7；迭代实施计划 M4-T11；Gate M4 G8）。
 *
 * 数据流只有一条：筛选条的任何一个控件变化 → `applyFilters()` 把当时的草稿压成
 * 一份 `applied` 快照 → 明细表（proxyConfig 读它）与 summary（loadSummary 读它）用
 * **同一份参数**发请求；指标卡与趋势折线都是 summary 的呈现，三块天然同口径。
 *
 * URL query 带 `projectId`/`prototypeId` 进入（M4-T12 从项目/原型详情跳转的入口，参数名与
 * access-log.query.controller.ts 接收的一致）：`routeScope` 的 watch（immediate）回填范围后
 * 统一发起首轮请求，且本页已在屏幕上时再次带范围跳入会重新筛
 * （proxyConfig.autoLoad=false，首轮与重筛都由 applyFilters 发起，不会先空查一次）。
 *
 * 概览的 5 个指标全部直读 /api/access-logs/summary 的字段，前端不算数、不补口径文案。
 * 导出 CSV 是 P1（接口设计 §6.3、后端未实现、M4-T11 判据未含），本轮不做也不留按钮。
 */
const route = useRoute();
const { hasAccessByCodes } = useAccess();

const canView = computed(() => hasAccessByCodes(['proto:accesslog:list']));

/* ── 筛选条草稿 ─────────────────────────────────────────────────────────── */

const preset = ref<AccessLogTimePreset>('week');
const customRange = ref<[Dayjs, Dayjs] | undefined>(undefined);
const resultFilter = ref<AccessLogResult | undefined>(undefined);
const keyword = ref('');

/**
 * 项目/原型两级范围。选择动作来自 PrototypePicker（复用，不重写两级联动）；
 * 该组件是无 v-model 的受控内状态实现（本期不许改它的文件），所以当前范围另外用
 * 可关闭的 Tag 呈现——URL 带参进来时靠它"看见并能清掉"，清掉时重挂 picker（:key）保持两处一致。
 */
const scope = ref<AccessLogScope>({});
const scopeLabels = ref<{ project?: string; prototype?: string }>({});
const pickerKey = ref(0);

/* ── 生效快照与三块数据 ─────────────────────────────────────────────────── */

const applied = ref<AppliedAccessLogFilters>({});
const summary = ref<AccessLogSummary | null>(null);
const summaryLoading = ref(false);
const summaryError = ref<null | string>(null);
const loadError = ref<null | string>(null);

/** vxe 代理回调参数：只要分页（本页无远端排序） */
interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
}

const resultOptions = ACCESS_LOG_RESULTS.map((value) => ({
  label: $t(`proto.accesslog.results.${value}`),
  value,
}));
const presetOptions = [
  { label: $t('proto.accesslog.filters.today'), value: 'today' },
  { label: $t('proto.accesslog.filters.last7d'), value: 'week' },
  { label: $t('proto.accesslog.filters.last30d'), value: 'month' },
  { label: $t('proto.accesslog.filters.custom'), value: 'custom' },
];

const trendDays = computed(() => summary.value?.daily.length ?? 0);

function currentWindow() {
  const range =
    preset.value === 'custom' && customRange.value !== undefined
      ? ([customRange.value[0].toDate(), customRange.value[1].toDate()] as [
          Date,
          Date,
        ])
      : null;
  return resolveTimeWindow(preset.value, range);
}

/** 草稿 → 快照，并让三个区块一起重新取数（判据：同一次筛选共用同一份参数） */
function applyFilters() {
  const window = currentWindow();
  applied.value = {
    endTime: window.endTime,
    keyword: keyword.value.trim() || undefined,
    projectId: scope.value.projectId,
    prototypeId: scope.value.prototypeId,
    result: resultFilter.value,
    startTime: window.startTime,
  };
  void loadSummary();
  gridApi.query();
}

/* ── summary：指标卡 + 趋势折线的唯一取数口 ─────────────────────────────── */

let summarySeq = 0;
async function loadSummary() {
  const seq = (summarySeq += 1);
  summaryLoading.value = true;
  try {
    const data = await getAccessLogSummaryApi(buildSummaryQuery(applied.value));
    if (seq !== summarySeq) {
      return; // 更晚发出的请求已经接管，丢掉这份过期响应
    }
    summary.value = data;
    summaryError.value = null;
  } catch (error) {
    if (seq !== summarySeq) {
      return;
    }
    summaryError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    if (seq === summarySeq) {
      summaryLoading.value = false;
    }
  }
}

/* ── 明细表 ─────────────────────────────────────────────────────────────── */

const [Grid, gridApi] = useVbenVxeGrid<AccessLogItem>({
  gridOptions: {
    columns: [
      { field: 'createdAt', slots: { default: 'time' }, title: $t('proto.accesslog.columns.createdAt'), width: 150 },
      { field: 'projectName', minWidth: 120, slots: { default: 'project' }, title: $t('proto.accesslog.columns.projectName') },
      { field: 'prototypeName', minWidth: 160, slots: { default: 'prototype' }, title: $t('proto.accesslog.columns.prototype') },
      { field: 'versionNo', slots: { default: 'version' }, title: $t('proto.accesslog.columns.versionNo'), width: 70 },
      { field: 'path', minWidth: 200, slots: { default: 'path' }, title: $t('proto.accesslog.columns.path') },
      { field: 'result', slots: { default: 'result' }, title: $t('proto.accesslog.columns.result'), width: 90 },
      { field: 'visitorName', slots: { default: 'visitor' }, title: $t('proto.accesslog.columns.visitor'), width: 110 },
      { field: 'ip', minWidth: 120, slots: { default: 'ip' }, title: 'IP' },
      { field: 'browser', minWidth: 150, slots: { default: 'env' }, title: $t('proto.accesslog.columns.env') },
      { field: 'referer', minWidth: 160, slots: { default: 'referer' }, title: $t('proto.accesslog.columns.referer') },
    ],
    height: 480,
    proxyConfig: {
      // 首轮请求由 routeScope 的 watch 回填 URL 筛选后的 applyFilters() 发起，避免先空查一次
      autoLoad: false,
      ajax: {
        query: async ({ page }: ProxyQueryArgs) => {
          try {
            const result = await getAccessLogsApi(
              buildListQuery(applied.value, {
                pageNumber: page.currentPage,
                pageSize: page.pageSize,
              }),
            );
            loadError.value = null;
            return result;
          } catch (error) {
            // 与项目列表页同款：失败保留表格 + 可重试横幅（服务端可读文案）
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
  },
});

/* ── 趋势折线（echarts 走 @vben/plugins/echarts 预置，不新增依赖）───────── */

const trendRef = ref<EchartsUIType>();
const { renderEcharts } = useEcharts(trendRef);

watch(summary, (value) => {
  void renderEcharts(
    buildTrendOption(value?.daily ?? [], {
      pv: $t('proto.accesslog.trend.pv'),
      uv: $t('proto.accesslog.trend.uv'),
    }),
  );
});

/* ── 控件回调 ───────────────────────────────────────────────────────────── */

function onPresetChange(event: RadioChangeEvent) {
  if (isAccessLogTimePreset(event.target.value)) {
    preset.value = event.target.value;
    applyFilters();
  }
}

function onResultChange(value: unknown) {
  resultFilter.value = isAccessLogResult(value) ? value : undefined;
  applyFilters();
}

function onPick(payload: { projectId: string; prototype: PrototypeListItem }) {
  scope.value = { projectId: payload.projectId, prototypeId: payload.prototype.id };
  scopeLabels.value = {
    prototype: `${payload.prototype.name}（${payload.prototype.code}）`,
  };
  applyFilters();
}

/** 清掉范围：同时重挂 PrototypePicker——它是内状态实现，不然它会显示一个已被清掉的选中项 */
function clearScope() {
  scope.value = {};
  scopeLabels.value = {};
  pickerKey.value += 1;
  applyFilters();
}

function onReset() {
  preset.value = 'week';
  customRange.value = undefined;
  resultFilter.value = undefined;
  keyword.value = '';
  clearScope();
}

/* ── URL 带参进入 + 同页内二次跳转（M4-T12）：范围随 route.query 变而重取 ───── */

/**
 * 范围回填 + 首轮取数由 `routeScope` 的 watch 统一驱动（immediate 覆盖首帧），
 * 而不是只在 onMounted 做一次——已在本页时从项目详情→原型详情→再点回访问记录，
 * route.query 换了范围要能重新筛。取名只为 Tag 那行字，失败按 id 兜底，绝不把筛选丢掉。
 */
const routeScope = computed(() => initialScopeFromQuery(route.query));

let scopeSeq = 0;
async function applyScopeFromRoute() {
  const seq = (scopeSeq += 1);
  const initial = routeScope.value;
  scopeLabels.value = {};
  if (initial.prototypeId !== undefined) {
    try {
      const prototype = await getPrototypeDetailApi(initial.prototypeId);
      if (seq !== scopeSeq) return; // 更新的跳转已接管，丢掉这份过期回填
      scope.value = {
        projectId: initial.projectId ?? prototype.projectId,
        prototypeId: prototype.id,
      };
      scopeLabels.value = { prototype: `${prototype.name}（${prototype.code}）` };
    } catch {
      if (seq !== scopeSeq) return;
      scope.value = initial;
    }
  } else if (initial.projectId !== undefined) {
    try {
      const project = await getProjectDetailApi(initial.projectId);
      if (seq !== scopeSeq) return;
      scope.value = { projectId: project.id };
      scopeLabels.value = { project: `${project.name}（${project.code}）` };
    } catch {
      if (seq !== scopeSeq) return;
      scope.value = initial;
    }
  } else {
    scope.value = {};
  }
  applyFilters();
}

// route.query 每次导航都是新对象，用范围等价判定滤掉"参数没变"的无谓重查；
// immediate 首帧 prev 为 undefined → 一定要跑一次（首轮 applyFilters 就挂在这里）
watch(
  routeScope,
  (next, prev) => {
    if (prev === undefined || !accessLogScopeEquals(prev, next)) {
      void applyScopeFromRoute();
    }
  },
  { immediate: true },
);

/** §3.7「浏览器/系统/设备」一列的次级行（os · 设备档位）；判定收在 accesslog-view，折叠区共用同一句 */
function envSubText(row: AccessLogItem): string {
  return accessLogEnvSubText(row, (key) => $t(key));
}
</script>

<template>
  <Page
    :description="$t('proto.accesslog.page.intro')"
    :title="$t('proto.accesslog.page.title')"
  >
    <div v-if="canView" class="flex flex-col gap-3">
      <!-- ① 筛选条：一个 Card 收拢所有控件（同类信息收敛在一处） -->
      <Card
        :bordered="false"
        size="small"
        :title="$t('proto.accesslog.filters.title')"
      >
        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-3">
            <PrototypePicker :key="pickerKey" @pick="onPick" />
            <RadioGroup
              :options="presetOptions"
              :value="preset"
              option-type="button"
              size="small"
              @change="onPresetChange"
            />
            <DatePicker.RangePicker
              v-if="preset === 'custom'"
              v-model:value="customRange"
              @change="applyFilters"
            />
            <Select
              :allow-clear="true"
              :options="resultOptions"
              :placeholder="$t('proto.accesslog.filters.resultPlaceholder')"
              class="min-w-32"
              size="small"
              @change="onResultChange"
            />
            <Input
              v-model:value="keyword"
              :placeholder="$t('proto.accesslog.filters.keywordPlaceholder')"
              allow-clear
              class="min-w-48"
              size="small"
              @press-enter="applyFilters"
            />
            <div class="flex items-center gap-2">
              <Button size="small" type="primary" @click="applyFilters">
                {{ $t('proto.common.search') }}
              </Button>
              <Button size="small" @click="onReset">
                {{ $t('proto.accesslog.filters.reset') }}
              </Button>
            </div>
          </div>

          <!-- 当前项目/原型范围：PrototypePicker 无 v-model（内状态），这里统一呈现一次并可清除 -->
          <div
            v-if="scope.projectId || scope.prototypeId"
            class="flex items-center gap-2"
            data-testid="accesslog-scope-chips"
          >
            <span class="text-xs text-muted-foreground">
              {{ $t('proto.accesslog.scope.title') }}
            </span>
            <Tag closable @close="clearScope">
              <template v-if="scope.prototypeId">
                {{ $t('proto.accesslog.scope.prototype') }}：{{ scopeLabels.prototype ?? scope.prototypeId }}
              </template>
              <template v-else>
                {{ $t('proto.accesslog.scope.project') }}：{{ scopeLabels.project ?? scope.projectId }}
              </template>
            </Tag>
          </div>
        </div>
      </Card>

      <!-- 汇总失败：指标卡与趋势图共用一次请求，失败一处说明一次并给重试 -->
      <Alert
        v-if="summaryError"
        :message="summaryError"
        banner
        type="error"
      >
        <template #action>
          <Button size="small" @click="loadSummary">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>

      <!-- ② 概览 5 指标（值全部直读 summary 字段） -->
      <AccessLogMetricCards :loading="summaryLoading" :summary="summary" />

      <!-- ③ 趋势折线：近 N 天 PV/UV（N 就是 summary.daily 的天数，卡片标题与数据同源） -->
      <Card
        :bordered="false"
        size="small"
        :title="$t('proto.accesslog.trend.title', [trendDays])"
      >
        <EchartsUI ref="trendRef" height="260px" />
      </Card>

      <!-- ④ 明细表 -->
      <Alert v-if="loadError" :message="loadError" banner type="error">
        <template #action>
          <Button size="small" @click="gridApi.query()">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>

      <Grid>
        <!-- L2：时间分两行，同项目列表「最近更新」列一个样式 -->
        <template #time="{ row }">
          <div class="leading-tight">
            <div>{{ splitDateTime(formatDateTime(row.createdAt)).date }}</div>
            <div class="text-muted-foreground text-xs">
              {{ splitDateTime(formatDateTime(row.createdAt)).time }}
            </div>
          </div>
        </template>

        <template #project="{ row }">
          <span v-if="row.projectName">{{ row.projectName }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </template>

        <!-- 判据行：原型为空 → 灰色「无效链接」+ routeKey 副标题（组件内含降级判定） -->
        <template #prototype="{ row }">
          <AccessLogPrototypeCell :row="row" />
        </template>

        <template #version="{ row }">
          <span v-if="row.versionNo !== null">{{ row.versionNo }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </template>

        <template #path="{ row }">
          <span class="font-mono text-xs">{{ row.path }}</span>
        </template>

        <template #result="{ row }">
          <Tag :color="resultTagOf(row.result).color">
            {{ $t(resultTagOf(row.result).labelKey) }}
          </Tag>
        </template>

        <template #visitor="{ row }">
          <span v-if="row.visitorName">{{ row.visitorName }}</span>
          <span v-else class="text-muted-foreground">
            {{ $t('proto.accesslog.anonymous') }}
          </span>
        </template>

        <template #ip="{ row }">
          <span v-if="row.ip" class="font-mono text-xs">{{ row.ip }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </template>

        <template #env="{ row }">
          <div class="leading-tight">
            <div>{{ row.browser ?? '—' }}</div>
            <div v-if="envSubText(row)" class="text-muted-foreground text-xs">
              {{ envSubText(row) }}
            </div>
          </div>
        </template>

        <template #referer="{ row }">
          <span v-if="row.referer" class="text-xs">{{ row.referer }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </template>
      </Grid>
    </div>

    <!-- 权限兜底：菜单本就按 proto:accesslog:list 下发，直接输 URL 才走到这里。
         §10.2「无权限」规定这种情况给**整页 403 页（vben 内置）**，不是塞一句"无权限"占位 -->
    <Fallback v-else status="403" />
  </Page>
</template>

<script setup lang="ts">
import type { DashboardOverview, RecentPrototypeItem } from '@protohub/shared';

import type { WorkspaceStatCard } from './workspace-view';

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';

import { Alert, Button, Card } from 'ant-design-vue';

import { getDashboardOverviewApi } from '#/api';
import DataState from '#/components/common/DataState.vue';
import StatCard from '#/components/common/StatCard.vue';
import ProtoStatusTag from '#/components/proto/ProtoStatusTag.vue';
import PublishDrawer from '#/components/proto/PublishDrawer.vue';
import ReleaseEventTimeline from '#/components/proto/ReleaseEventTimeline.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

import {
  relativeTimeOf,
  signedPercent,
  workspaceStatCards,
} from './workspace-view';

defineOptions({ name: 'DashboardWorkspace' });

/**
 * 工作台（前端设计 §3.1；迭代实施计划 M5-T1）：先看结论、再进入操作。
 *
 * 六块数据一次 `GET /api/dashboard/overview` 取回，界面上的数**不做二次加工**——
 * 判据是"与项目列表/访问记录页对得上"，口径只在服务端一处（计划 §9.2 DEV-38）。
 * 「最近更新的原型」列的是**原型**（不是项目），与 overview 契约同名字段一致。
 */
const router = useRouter();
const { hasAccessByCodes } = useAccess();

const overview = ref<DashboardOverview | null>(null);
const loading = ref(true);
const error = ref<null | string>(null);

const canUpload = computed(() => hasAccessByCodes(['proto:prototype:create']));

/** §3.4 抽屉的 create 模式：项目与原型都新建，一次动作把空工作台变成第一条可访问链接 */
const [PublishDrawerComp, publishDrawerApi] = useVbenDrawer({
  connectedComponent: PublishDrawer,
});

const statCards = computed(() => workspaceStatCards(overview.value));

const recentPrototypes = computed(
  () => overview.value?.recentPrototypes ?? [],
);

const recentEvents = computed(() => overview.value?.recentEvents ?? []);

/** 失败时不写"暂无数据"——那是"查过了没有"，不是"没查成"（§10.2 两者分开） */
const failed = computed(() => error.value !== null);

function subOf(card: WorkspaceStatCard): null | string {
  const delta = card.delta;
  if (delta === null) {
    return null;
  }
  // previous7d = 0 时没有可比性，不显示百分比（计划 §9.2 DEV-38 ⑤）
  return delta.percent === null
    ? $t('proto.workspace.stats.visitsPrevZero')
    : $t('proto.workspace.stats.visitsCompare', [signedPercent(delta.percent)]);
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    // 失败不清上一份数据（§10.2）：只有取到才覆盖
    overview.value = await getDashboardOverviewApi();
  } catch (caught) {
    error.value = toErrorMessage(caught) || $t('proto.common.loadFailed');
  } finally {
    loading.value = false;
  }
}

function onUpload() {
  publishDrawerApi.setData({ mode: 'create' });
  publishDrawerApi.open();
}

function onPrototypeDetail(row: RecentPrototypeItem) {
  router.push({ path: '/proto/prototype/detail', query: { id: row.id } });
}

load();
</script>

<template>
  <Page auto-content-height>
    <div class="flex h-full min-h-0 flex-col gap-4">
      <!-- 失败一处说明一次并给重试（§10.2），两块内容不各写一遍"加载失败" -->
      <Alert v-if="failed" :message="error ?? ''" banner type="error">
        <template #action>
          <Button size="small" @click="load">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>

      <!-- ① 顶部四张统计卡：项目数 / 原型数 / 本周发布次数 / 近 7 天访问量（含环比小字） -->
      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="workspace-stats">
        <StatCard
          v-for="card in statCards"
          :key="card.key"
          :label="$t(card.labelKey)"
          :loading="loading"
          :sub="subOf(card)"
          :test-id="`workspace-stat-${card.key}`"
          :value="card.value ?? '—'"
        />
      </div>

      <!-- ② 左 2/3 最近更新的原型（5 行）+ 右 1/3 最近动态（10 条）。
           "还没取到数 + 请求失败"时不渲染这两块：那不是"暂无数据"，是没查成，
           由上面的 Alert 一处说明；有上一份数据时照样展示（§10.2 不清空） -->
      <div
        v-if="overview !== null || !failed"
        class="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row"
      >
        <Card
          :bordered="false"
          :body-style="{ flex: 1, minHeight: 0, overflowY: 'auto' }"
          class="flex min-h-0 flex-1 flex-col overflow-hidden xl:flex-[2]"
          :head-style="{ flexShrink: 0 }"
          :title="$t('proto.workspace.recentPrototypes.title')"
        >
          <template #extra>
            <Button
              v-if="canUpload"
              data-testid="workspace-upload"
              type="primary"
              @click="onUpload"
            >
              {{ $t('proto.workspace.upload') }}
            </Button>
          </template>

          <DataState
            :empty="recentPrototypes.length === 0"
            :empty-text="$t('proto.workspace.recentPrototypes.empty')"
            :loading="loading"
            @retry="load"
          >
            <ul class="flex flex-col">
              <li
                v-for="row in recentPrototypes"
                :key="row.id"
                class="border-b border-border py-2 last:border-b-0"
                data-testid="workspace-recent-prototype"
              >
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button
                    class="max-w-full px-0 font-semibold"
                    type="link"
                    @click="onPrototypeDetail(row)"
                  >
                    <span class="truncate">{{ row.name }}</span>
                  </Button>
                  <ProtoStatusTag :status="row.status" />
                  <span class="text-muted-foreground ml-auto text-xs">
                    {{
                      $t('proto.workspace.recentPrototypes.visits', [
                        row.visitsLast7d,
                      ])
                    }}
                  </span>
                  <span class="text-muted-foreground text-xs">
                    {{ relativeTimeOf(row.updatedAt) }}
                  </span>
                </div>
                <p class="text-muted-foreground text-xs">
                  {{
                    $t('proto.workspace.recentPrototypes.ofProject', [
                      row.projectName,
                    ])
                  }}
                </p>
              </li>
            </ul>
          </DataState>
        </Card>

        <Card
          :bordered="false"
          :body-style="{ flex: 1, minHeight: 0, overflowY: 'auto' }"
          class="flex min-h-0 flex-1 flex-col overflow-hidden"
          :head-style="{ flexShrink: 0 }"
          :title="$t('proto.workspace.recentEvents.title')"
        >
          <ReleaseEventTimeline
            :events="recentEvents"
            :loading="loading"
            @retry="load"
          />
        </Card>
      </div>
    </div>

    <PublishDrawerComp @reload="load" />
  </Page>
</template>

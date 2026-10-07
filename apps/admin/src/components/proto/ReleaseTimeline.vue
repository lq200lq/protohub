<script setup lang="ts">
import type { ReleaseEventItem, ReleaseListItem } from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { formatDateTime } from '@vben/utils';

import {
  Alert,
  Button,
  Modal,
  Tag,
  Timeline,
  TimelineItem,
  message,
} from 'ant-design-vue';
import { Textarea } from 'ant-design-vue/es/input';

import { getReleaseEventsApi, getReleasesApi, rollbackReleaseApi } from '#/api';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import { formatBytes } from '#/utils/format';

defineOptions({ name: 'ReleaseTimeline' });

/**
 * 版本记录时间线（前端设计 §3.5、迭代实施计划 M3-T14）。
 *
 * 两条数据源合成一条流：§5.4 的版本行给"发布"这一类条目（也只有它有版本号、发布报告、
 * 能不能回滚），§5.8 的事件给"回滚 / 删除版本"这类**动作**——动作不是版本，一次回滚
 * 不产生新版本行，只在事件表里留一条痕迹。缺了事件流，时间线就说不清
 * "这条链接现在为什么是 v2 而不是 v3"。
 *
 * 发布报告的人话（"已将 12 处根绝对路径改写为 /p/crm/p01/ 前缀"）由服务端在流水线里写好
 * （机制 §2.6/§8.2），这里只原样渲染 `report[].message`，不在前端按计数重算第二套句子。
 */
const props = defineProps<{ prototypeId: string }>();

const emit = defineEmits<{ rolledBack: [] }>();

const { hasAccessByCodes } = useAccess();

/** 一期不做分页控件：50 条够覆盖一个原型的迭代次数，倒序呈现的是"最近发生了什么"。 */
const TIMELINE_PAGE_SIZE = 50;

type TimelineEntry =
  | {
      at: string;
      event: null;
      key: string;
      release: ReleaseListItem;
      type: 'release';
    }
  | {
      at: string;
      event: ReleaseEventItem;
      key: string;
      release: null;
      type: 'delete' | 'rollback';
    };

const releases = ref<ReleaseListItem[]>([]);
const events = ref<ReleaseEventItem[]>([]);
const loading = ref(false);
const error = ref<null | string>(null);
const expanded = ref<string[]>([]);

const canRollback = computed(() => hasAccessByCodes(['proto:prototype:rollback']));

const entries = computed<TimelineEntry[]>(() => {
  const rows: TimelineEntry[] = releases.value.map((release) => ({
    at: release.createdAt,
    event: null,
    key: `r-${release.id}`,
    release,
    type: 'release' as const,
  }));
  for (const event of events.value) {
    // publish 事件与版本行是同一次发布的两面（§5.8 事件表逐条对应版本行），
    // 版本行已经把它画出来了，再画一遍就是两条重复的"发布 v3"。
    if (event.eventType === 'publish') {
      continue;
    }
    rows.push({
      at: event.createdAt,
      event,
      key: `e-${event.id}`,
      release: null,
      type: event.eventType === 'delete_version' ? 'delete' : 'rollback',
    });
  }
  return rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
});

async function load() {
  if (!props.prototypeId) {
    releases.value = [];
    events.value = [];
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    const [releasePage, eventPage] = await Promise.all([
      getReleasesApi(props.prototypeId, {
        page: 1,
        pageSize: TIMELINE_PAGE_SIZE,
        sortOrder: 'desc',
      }),
      getReleaseEventsApi(props.prototypeId, {
        page: 1,
        pageSize: TIMELINE_PAGE_SIZE,
      }),
    ]);
    releases.value = releasePage.items;
    events.value = eventPage.items;
  } catch (caught) {
    error.value = toErrorMessage(caught) || $t('proto.common.loadFailed');
  } finally {
    loading.value = false;
  }
}

function toggleReport(key: string) {
  expanded.value = expanded.value.includes(key)
    ? expanded.value.filter((item) => item !== key)
    : [...expanded.value, key];
}

/* ---------- 回滚（§5.5：原因可选，落进事件行的 reason） ---------- */

const rollbackTarget = ref<null | ReleaseListItem>(null);
const rollbackReason = ref('');
const rollbackError = ref<null | string>(null);
const rollingBack = ref(false);

function askRollback(release: ReleaseListItem) {
  rollbackReason.value = '';
  rollbackError.value = null;
  rollbackTarget.value = release;
}

async function confirmRollback() {
  const target = rollbackTarget.value;
  if (target === null) {
    return;
  }
  rollingBack.value = true;
  rollbackError.value = null;
  try {
    await rollbackReleaseApi(props.prototypeId, target.id, rollbackReason.value);
    message.success($t('proto.release.rollback.done', [target.versionNo]));
    rollbackTarget.value = null;
    await load();
    // 当前生效指针变了：父页面要重取详情，"当前版本"卡片与链接说明才跟得上
    emit('rolledBack');
  } catch (caught) {
    rollbackError.value = toErrorMessage(caught) || $t('proto.common.loadFailed');
  } finally {
    rollingBack.value = false;
  }
}

watch(() => props.prototypeId, load);

defineExpose({ reload: load });

load();
</script>

<template>
  <DataState
    :empty="entries.length === 0"
    :empty-text="$t('proto.release.timelineEmpty')"
    :error="error"
    :loading="loading"
    @retry="load"
  >
    <Timeline class="pt-1">
      <TimelineItem
        v-for="entry in entries"
        :key="entry.key"
        :color="
          entry.type === 'release'
            ? entry.release.isCurrent
              ? 'green'
              : entry.release.status === 'broken'
                ? 'red'
                : 'blue'
            : 'gray'
        "
      >
        <!-- 发布：一条版本行 -->
        <div v-if="entry.type === 'release'" class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <Tag color="blue">
              {{ $t('proto.prototype.version.no', [entry.release.versionNo]) }}
            </Tag>
            <Tag v-if="entry.release.isCurrent" color="green">
              {{ $t('proto.release.current') }}
            </Tag>
            <span class="text-muted-foreground text-xs">
              {{ $t('proto.release.eventTypes.publish') }} ·
              {{ entry.release.createdByName }} · {{ formatDateTime(entry.at) }}
            </span>
          </div>
          <p class="text-sm">
            {{ entry.release.note || $t('proto.release.versionNoteEmpty') }}
          </p>
          <p class="text-muted-foreground text-xs">
            {{ entry.release.sourceName || '—' }} ·
            {{ formatBytes(entry.release.totalBytes) }} ·
            {{ entry.release.fileCount }} · {{ entry.release.entryFile }}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <Button size="small" type="link" @click="toggleReport(entry.key)">
              {{
                expanded.includes(entry.key)
                  ? $t('proto.release.report.hide')
                  : $t('proto.release.report.title')
              }}
            </Button>
            <Button
              v-if="canRollback && !entry.release.isCurrent"
              size="small"
              @click="askRollback(entry.release)"
            >
              {{ $t('proto.release.rollback.action') }}
            </Button>
          </div>
          <div
            v-if="expanded.includes(entry.key)"
            class="mt-1 rounded-md bg-accent p-2"
            data-testid="release-report"
          >
            <ul
              v-if="entry.release.report.length > 0"
              class="flex list-none flex-col gap-1"
            >
              <li
                v-for="(warning, index) in entry.release.report"
                :key="`${entry.key}-${String(index)}`"
                class="text-xs"
              >
                {{ warning.message }}
              </li>
            </ul>
            <p v-else class="text-muted-foreground text-xs">
              {{ $t('proto.release.report.none') }}
            </p>
          </div>
        </div>

        <!-- 回滚 / 删除版本：事件行动作，没有版本行可展开 -->
        <div v-else class="flex flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <Tag :color="entry.type === 'delete' ? 'red' : 'orange'">
              {{
                entry.type === 'delete'
                  ? $t('proto.release.eventTypes.delete')
                  : $t('proto.release.eventTypes.rollback')
              }}
            </Tag>
            <span class="text-muted-foreground text-xs">
              {{ entry.event.operatorName }} · {{ formatDateTime(entry.at) }}
            </span>
          </div>
          <p class="text-sm">
            <template v-if="entry.type === 'rollback'">
              {{
                $t('proto.release.rollback.fromTo', [
                  entry.event.fromVersionNo ?? '—',
                  entry.event.toVersionNo ?? '—',
                ])
              }}
            </template>
            <template v-else>
              {{
                $t('proto.release.deletedVersion.of', [
                  entry.event.fromVersionNo ?? '—',
                ])
              }}
            </template>
          </p>
          <p v-if="entry.event.reason" class="text-muted-foreground text-xs">
            {{ $t('proto.release.versionNote') }}：{{ entry.event.reason }}
          </p>
        </div>
      </TimelineItem>
    </Timeline>
  </DataState>

  <!-- 回滚确认：原因可选，服务端把它写进事件行，界面与审计读同一句 -->
  <Modal
    :cancel-disabled="rollingBack"
    :confirm-loading="rollingBack"
    :ok-disabled="rollingBack"
    :open="rollbackTarget !== null"
    :title="$t('proto.release.rollback.title')"
    :width="480"
    @cancel="rollbackTarget = null"
    @ok="confirmRollback"
  >
    <p class="mb-2 text-sm">
      {{ $t('proto.release.rollback.confirm', [rollbackTarget?.versionNo ?? '']) }}
    </p>
    <Textarea
      v-model:value="rollbackReason"
      :maxlength="200"
      :placeholder="$t('proto.release.rollback.reason')"
      :rows="3"
    />
    <Alert
      v-if="rollbackError"
      :message="rollbackError"
      banner
      class="mt-2"
      type="error"
    />
  </Modal>
</template>

<script setup lang="ts">
import type { PublishTaskRow } from '#/store';

import { computed } from 'vue';

import { IconifyIcon } from '@vben/icons';

import { Button, Progress } from 'ant-design-vue';

import { isFinalUploadTaskStatus } from '#/api';
import CopyText from '#/components/proto/CopyText.vue';
import { $t } from '#/locales';
import { usePublishTaskStore } from '#/store';
import { formatBytes } from '#/utils/format';
import { uploadStageLabelKey } from '#/utils/upload';

defineOptions({ name: 'PublishTaskFloat' });

/**
 * 右下角的发布任务浮层（前端设计 §3.4「关闭抽屉不阻止任务」的落点、§7 的 usePublishTaskStore 视图）。
 *
 * 挂在 basic 布局上，所以任何页面都能看到——发起发布的那个页面在两三分钟后可能早就被切走了。
 * 数据全部来自 store，本组件不持有任何状态、也不自己轮询：抽屉正显示的那一条由 store 滤掉，
 * 免得同一个任务在两处各画一份进度。
 */
const store = usePublishTaskStore();

const rows = computed(() => store.floatTasks);

function isFinal(row: PublishTaskRow): boolean {
  return isFinalUploadTaskStatus(row.status);
}

function stageText(row: PublishTaskRow): string {
  return $t('proto.publish.serverStage', [
    $t(uploadStageLabelKey(row.stage)),
    row.progress,
  ]);
}

function openLink(url: null | string): void {
  if (url !== null) {
    window.open(url, '_blank', 'noopener');
  }
}
</script>

<template>
  <!-- 传送到 body：布局里任何带 transform 的祖先都会让 position:fixed 相对它定位，右下角就跑偏了 -->
  <Teleport to="body">
    <div
      v-if="rows.length > 0"
      class="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      data-testid="publish-task-float"
    >
      <div
        v-for="row in rows"
        :key="row.id"
        class="space-y-2 rounded-md border border-border bg-card p-3 shadow-lg"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">{{ row.prototypeName }}</p>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ row.file.name }} · {{ formatBytes(row.file.size) }}
            </p>
          </div>
          <Button
            :aria-label="$t('proto.publish.dismiss')"
            size="small"
            type="text"
            @click="store.dismiss(row.id)"
          >
            <template #icon>
              <IconifyIcon icon="lucide:x" class="size-3.5" />
            </template>
          </Button>
        </div>

        <!-- 第一段：浏览器 → 服务端的上传进度 -->
        <div v-if="row.uploading">
          <Progress :percent="row.uploadPercent" size="small" />
          <p class="text-xs text-muted-foreground">
            {{ $t('proto.uploader.uploading') }}
          </p>
        </div>

        <!-- 第二段：服务端处理进度（与上传分开，绝不合成一条） -->
        <div v-else-if="row.status === 'pending' || row.status === 'processing'">
          <Progress :percent="row.progress" size="small" />
          <p class="text-xs text-muted-foreground">
            {{
              row.status === 'pending'
                ? $t('proto.uploader.queued')
                : stageText(row)
            }}
          </p>
        </div>

        <!-- 成功态要留得住：这条链接是这次发布的全部产出 -->
        <div
          v-else-if="row.status === 'success' && row.accessUrl"
          class="space-y-1.5"
        >
          <p class="text-xs font-semibold">
            {{ $t('proto.publish.published') }}
          </p>
          <CopyText :max-width="260" :text="row.accessUrl" />
          <div class="flex gap-1">
            <Button size="small" @click="openLink(row.accessUrl)">
              {{ $t('proto.prototype.openLink') }}
            </Button>
            <Button
              size="small"
              type="link"
              @click="store.goPrototypeDetail(row.prototypeId)"
            >
              {{ $t('proto.publish.viewDetail') }}
            </Button>
          </div>
        </div>

        <!-- 失败态：人话由服务端给 + 重试（复用同一个包，不重填表单） -->
        <div v-else-if="row.error" class="space-y-1.5">
          <p class="text-xs font-semibold text-destructive">
            {{ $t('proto.uploader.failed') }}：{{ row.error.message }}
          </p>
          <p
            v-if="row.error.errorCode"
            class="font-mono text-xs text-muted-foreground"
          >
            {{ row.error.errorCode }}
          </p>
          <Button v-if="isFinal(row)" size="small" @click="store.retry(row.id)">
            {{ $t('proto.common.retry') }}
          </Button>
        </div>

        <!-- 还没判出结果但已经不再替用户等：给出口而不是假死 -->
        <div v-if="row.notice" class="space-y-1.5">
          <p class="text-xs text-muted-foreground">{{ row.notice }}</p>
          <div class="flex gap-1">
            <Button
              v-if="row.taskId !== null && !isFinal(row)"
              size="small"
              @click="store.resumeWaiting(row.id)"
            >
              {{ $t('proto.publish.keepWaiting') }}
            </Button>
            <Button
              size="small"
              type="link"
              @click="store.goPrototypeDetail(row.prototypeId)"
            >
              {{ $t('proto.publish.viewDetail') }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

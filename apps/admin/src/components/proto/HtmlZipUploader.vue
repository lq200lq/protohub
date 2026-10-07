<script setup lang="ts">
import { computed, ref } from 'vue';

import { DEFAULT_MAX_UPLOAD_BYTES } from '@protohub/shared';

import { Button, Progress, Steps } from 'ant-design-vue';

import { $t } from '#/locales';
import { formatBytes } from '#/utils/format';
import {
  type UploadLocalIssue,
  type UploaderTaskState,
  uploadStepView,
  zipFileIssue,
} from '#/utils/upload';

defineOptions({ name: 'HtmlZipUploader' });

/**
 * HTML zip 上传区（前端设计 §3.4 的状态机；上传发布页与上传抽屉共用一处实现）。
 *
 * 组件只管**文件**这一段：选择、拖拽、本地预检，以及把两段进度分开画出来——
 * 上传进度（浏览器 → 服务端）用文件行里的进度条，服务端处理进度（§5.3 的 `stage`）用步骤条。
 * 混成一条是设计里点名要避免的：包到 100% 之后还要等解压与改写，用户会以为卡住了。
 *
 * 受理与轮询由调用方（`usePublishTaskStore`）驱动，状态通过 `task` 传进来：
 * 关掉抽屉后任务要在右下角继续跑，进度也就不能长在只活到关闭为止的组件里。
 */
const props = withDefaults(
  defineProps<{
    accept?: string;
    disabled?: boolean;
    maxSizeBytes?: number;
    /** §5.3 任务状态里与进度相关的四个字段；null 表示还没受理成功（此时只有上传进度可看） */
    task?: null | UploaderTaskState;
    uploading?: boolean;
    uploadPercent?: number;
  }>(),
  {
    accept: '.zip',
    disabled: false,
    maxSizeBytes: DEFAULT_MAX_UPLOAD_BYTES,
    task: null,
    uploading: false,
    uploadPercent: 0,
  },
);

const emit = defineEmits<{ remove: [] }>();

const file = defineModel<null | File>('file', { default: null });

const inputEl = ref<null | HTMLInputElement>(null);
const dragging = ref(false);
const localIssue = ref<null | UploadLocalIssue>(null);

const sizeHint = computed(() =>
  $t('proto.uploader.sizeHint', [formatBytes(props.maxSizeBytes)]),
);

/** 超限那条要说得出"上限是多少"，否则用户只会换一个同样大的文件再来一次。 */
const localIssueText = computed(() => {
  const issue = localIssue.value;
  if (issue === null) {
    return '';
  }
  return issue === 'tooLarge'
    ? $t('proto.uploader.issues.tooLarge', [formatBytes(props.maxSizeBytes)])
    : $t(`proto.uploader.issues.${issue}`);
});

/** 处理中不让换文件：请求已经在路上，此时选中的第二个文件只会让用户以为传的是它。 */
const locked = computed(
  () =>
    props.disabled ||
    props.uploading ||
    (props.task !== null && isInFlight(props.task.status)),
);

const stepView = computed(() =>
  props.task === null ? null : uploadStepView(props.task),
);

const stepItems = computed(() =>
  stepView.value === null
    ? []
    : stepView.value.labelKeys.map((key) => ({ title: $t(key) })),
);

const stepText = computed(() => {
  const view = stepView.value;
  if (view === null || view.textKey === null) {
    return '';
  }
  return $t(view.textKey, view.textParams);
});

const failure = computed(() => props.task?.error ?? null);

const uploaded = computed(() => props.task?.status === 'success');

function openPicker() {
  if (locked.value) {
    return;
  }
  inputEl.value?.click();
}

function takeFile(candidate: undefined | File): void {
  if (!candidate) {
    return;
  }
  const issue = zipFileIssue(candidate, props.maxSizeBytes);
  localIssue.value = issue;
  if (issue === null) {
    file.value = candidate;
  } else {
    file.value = null;
  }
}

function onInputChange(event: Event) {
  const target = event.target as HTMLInputElement;
  takeFile(target.files?.[0]);
  // 清空 value：同一个文件再选一次也要触发 change（改完包重传是高频动作）
  target.value = '';
}

function onDrop(event: DragEvent) {
  dragging.value = false;
  if (locked.value) {
    return;
  }
  takeFile(event.dataTransfer?.files[0]);
}

function clearFile() {
  file.value = null;
  localIssue.value = null;
  emit('remove');
}

function isInFlight(status: UploaderTaskState['status']): boolean {
  return status === 'pending' || status === 'processing';
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-if="file === null"
      :class="
        dragging
          ? 'border-primary bg-accent'
          : localIssue
            ? 'border-destructive'
            : 'border-dashed'
      "
      class="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-border px-4 py-8 text-center transition-colors"
      role="button"
      tabindex="0"
      @click="openPicker"
      @dragleave.prevent="dragging = false"
      @dragover.prevent="dragging = true"
      @drop.prevent="onDrop"
      @keydown.enter.prevent="openPicker"
    >
      <p class="text-sm font-semibold">{{ $t('proto.uploader.dropHere') }}</p>
      <p class="text-xs text-muted-foreground">{{ sizeHint }}</p>
      <p
        v-if="localIssueText"
        class="mt-1 text-xs text-destructive"
        data-testid="uploader-local-issue"
      >
        {{ localIssueText }}
      </p>
    </div>

    <div v-else class="rounded-md border border-border p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold">{{ file.name }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ formatBytes(file.size) }}
            <span v-if="uploaded" class="ml-1">
              · {{ $t('proto.uploader.published') }}
            </span>
          </p>
        </div>
        <Button
          :disabled="locked"
          size="small"
          type="link"
          @click="clearFile"
        >
          {{ $t('proto.uploader.remove') }}
        </Button>
      </div>

      <!-- 第一段：浏览器 → 服务端的上传进度 -->
      <div v-if="uploading">
        <Progress :percent="uploadPercent" size="small" />
        <p class="text-xs text-muted-foreground">
          {{ $t('proto.uploader.uploading') }}
        </p>
      </div>

      <!-- 第二段：服务端处理进度（步骤条随 §5.3 的 stage 变化） -->
      <div v-else-if="stepView">
        <Steps
          :current="stepView.current"
          :items="stepItems"
          :status="stepView.status"
          class="uploader-steps"
          size="small"
        />
        <p v-if="stepText" class="text-xs text-muted-foreground">
          {{ stepText }}
        </p>
      </div>

      <!-- 失败：人话由服务端给（§5.3 error.message），稳定码小字留给报障 -->
      <div v-if="failure" class="mt-2 rounded-md bg-accent p-2">
        <p class="text-xs font-semibold text-destructive">
          {{ $t('proto.uploader.failed') }}：{{ failure.message }}
        </p>
        <p
          v-if="failure.errorCode"
          class="mt-0.5 font-mono text-xs text-muted-foreground"
        >
          {{ failure.errorCode }}
        </p>
      </div>
    </div>

    <input
      ref="inputEl"
      :accept="accept"
      class="hidden"
      type="file"
      @change="onInputChange"
    />
  </div>
</template>

<style scoped>
/* 四段步骤条在抽屉的宽度里要靠压缩标题放下；不额外做响应式，超出就横向滚动 */
.uploader-steps {
  overflow-x: auto;
}
</style>

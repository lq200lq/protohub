<script setup lang="ts">
import type { PublishTaskRow } from '#/store';

import { computed } from 'vue';

import { ERROR_CODES, UPLOAD_ERROR_CODES } from '@protohub/shared';

import { Button, Checkbox } from 'ant-design-vue';

import HtmlZipUploader from '#/components/proto/HtmlZipUploader.vue';
import { $t } from '#/locales';
import { usePublishTaskStore } from '#/store';

defineOptions({ name: 'PublishTaskPanel' });

/**
 * 「选文件 + 这次发布的任务出口」面板（前端设计 §3.4 区块 ③）。
 *
 * 拖拽区、两段进度、失败后的「强制发布」勾选与查不到任务时的「继续等待 / 去详情看结果」
 * 出口都收在这里：出口语义分散到各调用方各写一遍就会漂掉（比如漏了「强制发布」，
 * 用户只能重发一次），所以按 §3.7 收成一处。
 *
 * 失败的人话与稳定码由 `HtmlZipUploader` 给（机制 §8.2：文案在服务端生成），这里只补"下一步做什么"；
 * **主按钮不在这里**——「立即发布 / 重试」的语义由载体给（抽屉是底部确认按钮），
 * 判定走 `utils/publish-action`；这里再画一个重试就成了同屏两个同义按钮。
 * 导航同样交回调用方（emit `goDetail`）：由调用方决定点完是关抽屉还是换页。
 */
const props = defineProps<{ row: null | PublishTaskRow }>();

const emit = defineEmits<{ goDetail: [prototypeId: string] }>();

const file = defineModel<null | File>('file', { default: null });
const force = defineModel<boolean>('force', { default: false });

const store = usePublishTaskStore();

const failed = computed(
  () => props.row?.status === 'canceled' || props.row?.status === 'failed',
);
/** 内容与当前版本相同：唯一的出路就是勾选强制发布再重发一次（接口设计 §5.1 的 `force`） */
const isDuplicate = computed(
  () =>
    props.row?.error?.errorCode === UPLOAD_ERROR_CODES.UPLOAD_DUPLICATE_CONTENT,
);
/** 目标原型已被删除：重试没有意义，只能另选目标（机制 §3.2，计划 §9.2 DEV-18） */
const isTargetGone = computed(
  () => props.row?.error?.errorCode === ERROR_CODES.PROTO_NOT_FOUND,
);

function resumeWaiting() {
  const current = props.row;
  if (current !== null) {
    store.resumeWaiting(current.id);
  }
}

function goDetail() {
  const prototypeId = props.row?.prototypeId;
  if (prototypeId !== null && prototypeId !== undefined) {
    emit('goDetail', prototypeId);
  }
}
</script>

<template>
  <div class="space-y-2">
    <HtmlZipUploader
      v-model:file="file"
      :task="props.row"
      :upload-percent="props.row?.uploadPercent ?? 0"
      :uploading="props.row?.uploading === true"
    />

    <!-- 失败：上传器给"为什么"，这里给这条失败特有的出路（重复→强制发布，原型没了→另选目标） -->
    <div v-if="failed && props.row" class="space-y-2">
      <Checkbox
        v-if="isDuplicate"
        v-model:checked="force"
        data-testid="publish-force"
      >
        {{ $t('proto.publish.forcePublish') }}
      </Checkbox>
      <p
        v-if="isDuplicate || isTargetGone"
        class="text-xs text-muted-foreground"
        data-testid="publish-failure-hint"
      >
        {{
          isTargetGone
            ? $t('proto.publish.targetGoneHint')
            : $t('proto.publish.duplicateHint')
        }}
      </p>
      <Button size="small" type="link" @click="goDetail">
        {{ $t('proto.publish.viewReport') }}
      </Button>
    </div>

    <!-- 查不到任务了：给"继续等"和"去详情看结果"两条出口，而不是把人锁在这里 -->
    <div v-if="props.row?.notice" class="flex flex-wrap items-center gap-2">
      <p class="w-full text-xs text-muted-foreground">{{ props.row.notice }}</p>
      <Button
        v-if="props.row.taskId !== null && !failed"
        data-testid="publish-keep-waiting"
        size="small"
        @click="resumeWaiting"
      >
        {{ $t('proto.publish.keepWaiting') }}
      </Button>
      <Button size="small" type="link" @click="goDetail">
        {{ $t('proto.publish.viewDetail') }}
      </Button>
    </div>
  </div>
</template>

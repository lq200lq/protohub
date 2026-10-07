<script setup lang="ts">
import type { PrototypeListItem } from '@protohub/shared';

import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';
import { RELEASE_NOTE_MAX_LENGTH } from '@protohub/shared';

import { Alert, Button, Card } from 'ant-design-vue';
import { Textarea } from 'ant-design-vue/es/input';

import { getProjectDetailApi, getPrototypeDetailApi } from '#/api';
import CopyText from '#/components/proto/CopyText.vue';
import ProtoStatusTag from '#/components/proto/ProtoStatusTag.vue';
import PublishDrawer from '#/components/proto/PublishDrawer.vue';
import PublishTaskPanel from '#/components/proto/PublishTaskPanel.vue';
import PrototypePicker from '#/components/proto/PrototypePicker.vue';
import { $t } from '#/locales';
import { usePublishTaskStore } from '#/store';
import { publishActionOf } from '#/utils/publish-action';
import { toErrorMessage } from '#/utils/error';
import { formatBytes } from '#/utils/format';

defineOptions({ name: 'ProtoPublish' });

/**
 * 上传发布页（前端设计 §3.6；迭代实施计划 M3-T13）。
 *
 * 面向"把新导出的包覆盖到已有原型"这一高频动作，与 §3.4 抽屉的分工是**项目与原型都靠选、不靠新建**：
 * 目标一定后链接就不变了，所以整页只需要"选中→确认没选错→换包"三步，摘要必须摆在上传区之前
 * （判据：选中原型后展示其当前版本摘要与访问地址）。
 *
 * 上传区与失败出口不在这里重写：那是 §3.4 区块 ③ 的同一段，走 `PublishTaskPanel`；
 * 主按钮的"立即发布 / 重试"判定与抽屉共用 `utils/publish-action`，两处只换渲染载体。
 * 「＋ 新建原型」把已有的项目交给抽屉的 `newPrototype` 模式——新建归抽屉，覆盖归本页，一份实现两处用。
 */
const store = usePublishTaskStore();
const { hasAccessByCodes } = useAccess();

const canPublish = computed(() =>
  hasAccessByCodes(['proto:prototype:publish']),
);

/** 目标原型：列表行够用（`currentRelease` 摘要与 `accessUrl` 都在 §4.3.1 的行里） */
const target = ref<null | PrototypeListItem>(null);
/** 归属项目身份：抽屉的 `newPrototype` 模式要把项目带过去锁死 */
const pickedProject = ref<null | { code: string; id: string; name: string }>(null);

const note = ref('');
const file = ref<null | File>(null);
const forceChecked = ref(false);
const formError = ref<null | string>(null);
const taskId = ref<null | string>(null);

const row = computed(() => store.taskOf(taskId.value));
const action = computed(() => publishActionOf(row.value));
const succeeded = computed(() => row.value?.status === 'success');
const summary = computed(() => target.value?.currentRelease ?? null);

async function onPick(payload: { projectId: string; prototype: PrototypeListItem }) {
  target.value = payload.prototype;
  // 换目标等于换一次发布：上一行任务交还给右下角浮层继续显示，不在这里接着挂
  releaseRow();
  formError.value = null;
  pickedProject.value = null;
  try {
    const project = await getProjectDetailApi(payload.projectId);
    pickedProject.value = { code: project.code, id: project.id, name: project.name };
  } catch (caught) {
    // 项目名取不到只影响摘要里那一行与「新建原型」的预填，不该把已选好的原型丢掉
    formError.value = toErrorMessage(caught);
  }
}

function releaseRow() {
  if (taskId.value !== null && store.heldId === taskId.value) {
    store.hold(null);
  }
  taskId.value = null;
}

/* ── 发布：与抽屉同一套提交/重试规则，只是载体是页内按钮 ─────────────────── */
function onPrimaryAction() {
  if (action.value.kind === 'retry') {
    const current = row.value;
    if (current !== null) {
      // 复用那一行：同一个包、不重填表单（§3.4）；勾了「强制发布」才带 force
      store.retry(current.id, { force: forceChecked.value });
    }
    return;
  }
  startPublish();
}

/** 详情是发布报告与版本记录的落点（§3.5）：页面点导航就换页，不像抽屉那样还要关自己 */
function openDetail(prototypeId: string) {
  void store.goPrototypeDetail(prototypeId);
}

function startPublish() {
  if (target.value === null) {
    formError.value = $t('proto.publish.prototypeRequired');
    return;
  }
  if (file.value === null) {
    formError.value = $t('proto.publish.fileRequired');
    return;
  }
  formError.value = null;
  const text = note.value.trim();
  taskId.value = store.submit({
    file: file.value,
    form: {
      note: text === '' ? undefined : text,
      prototypeId: target.value.id,
    },
    prototypeName: target.value.name,
  });
}

/** 发布成功后当前版本换了：摘要与版本数要跟着走，否则用户只能刷新整页 */
watch(succeeded, async (value) => {
  if (!value) {
    return;
  }
  file.value = null;
  note.value = '';
  await refreshTarget();
  // 成功行也在这一步交回浮层：不然 `action` 永远停在 done、主按钮再点不动，
  // 而 §3.6 这页就是拿来连着覆盖同一个原型的（成功已由 toast + 新摘要表达，无独立成功屏）
  releaseRow();
});

async function refreshTarget() {
  const current = target.value;
  if (current === null) {
    return;
  }
  try {
    target.value = await getPrototypeDetailApi(current.id);
  } catch (caught) {
    formError.value = toErrorMessage(caught);
  }
}

/** 「＋ 新建原型」：原型这一层归 §3.4 抽屉，项目已选中就带过去锁死（§3.6 的分工） */
const [PublishDrawerComp, publishDrawerApi] = useVbenDrawer({
  connectedComponent: PublishDrawer,
});

function onNewPrototype() {
  const project = pickedProject.value;
  publishDrawerApi.setData(
    project === null
      ? { mode: 'create' }
      : {
          mode: 'newPrototype',
          projectCode: project.code,
          projectId: project.id,
          projectName: project.name,
        },
  );
  publishDrawerApi.open();
}

onBeforeUnmount(() => {
  // 离开页面不该打断发布：那一行还给浮层，右下角接着显示进度与结果
  releaseRow();
});
</script>

<template>
  <Page
    :description="$t('proto.publish.page.intro')"
    :title="$t('proto.publish.page.title')"
  >
    <!-- 页面自己滚动：发布表单不长，没必要把高度算成视口减去页头（算错就多出一条内滚或截掉按钮） -->
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start">
      <Card
        :bordered="false"
        class="min-w-0 flex-1"
        size="small"
        :title="$t('proto.publish.sections.pick')"
      >
        <template #extra>
          <Button size="small" @click="onNewPrototype">
            {{ $t('proto.publish.newPrototype') }}
          </Button>
        </template>

        <div class="flex flex-col gap-4">
          <PrototypePicker @pick="onPick" />

          <!-- 选中后的当前版本摘要：判据要求的"确认没选错"就靠这一段 -->
          <div v-if="target" class="flex flex-col gap-2" data-testid="publish-target">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold">{{ target.name }}</span>
              <span class="font-mono text-xs text-muted-foreground">
                {{ target.code }}
              </span>
              <ProtoStatusTag :status="target.status" />
            </div>
            <p v-if="summary" class="text-sm">
              {{ $t('proto.publish.currentVersion', [summary.versionNo]) }}
              <span class="text-muted-foreground">
                · {{ $t('proto.publish.versionCount', [target.releaseCount]) }}
              </span>
            </p>
            <p v-else class="text-sm text-muted-foreground">
              {{ $t('proto.publish.noCurrentVersion') }}
            </p>
            <div
              v-if="summary"
              class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4"
            >
              <div>
                <p class="text-xs text-muted-foreground">
                  {{ $t('proto.prototype.version.publishedAt') }}
                </p>
                <p>{{ formatDateTime(new Date(summary.publishedAt)) }}</p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">
                  {{ $t('proto.prototype.version.publishedBy') }}
                </p>
                <p>{{ summary.publishedByName }}</p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">
                  {{ $t('proto.prototype.version.fileCount') }}
                </p>
                <p>{{ summary.fileCount }}</p>
              </div>
              <div>
                <p class="text-xs text-muted-foreground">
                  {{ $t('proto.prototype.version.totalBytes') }}
                </p>
                <p>{{ formatBytes(summary.totalBytes) }}</p>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground">
                {{ $t('proto.prototype.columns.accessUrl') }}
              </span>
              <CopyText :max-width="420" :text="target.accessUrl" />
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">
            {{ $t('proto.publish.page.pickNothing') }}
          </p>

          <!-- ② 版本说明 -->
          <div class="flex flex-col gap-1">
            <p class="text-sm font-semibold">{{ $t('proto.publish.noteLabel') }}</p>
            <Textarea
              v-model:value="note"
              :maxlength="RELEASE_NOTE_MAX_LENGTH"
              :placeholder="$t('proto.publish.notePlaceholder')"
              :rows="2"
              data-testid="publish-note"
              show-count
            />
          </div>

          <!-- ③ 上传文件：一段实现在 PublishTaskPanel（拖拽 + 两段进度 + 失败与等待的出口） -->
          <div class="flex flex-col gap-1">
            <p class="text-sm font-semibold">
              {{ $t('proto.publish.sections.file') }}
            </p>
            <PublishTaskPanel
              v-model:file="file"
              v-model:force="forceChecked"
              :row="row"
              @go-detail="openDetail"
            />
          </div>

          <p
            v-if="formError"
            class="text-xs text-destructive"
            data-testid="publish-form-error"
          >
            {{ formError }}
          </p>

          <div class="flex items-center gap-2">
            <Button
              :disabled="!action.runnable || !canPublish"
              type="primary"
              @click="onPrimaryAction"
            >
              {{ $t(action.labelKey) }}
            </Button>
          </div>
        </div>
      </Card>

      <!-- 右侧提示条：这条链接不变是本页存在的理由，说明放在手边（§3.6） -->
      <div class="w-full shrink-0 lg:max-w-72">
        <Alert
          :description="$t('proto.publish.appendHint')"
          :message="$t('proto.publish.appendTitle')"
          show-icon
          type="info"
        />
      </div>
    </div>

    <PublishDrawerComp @reload="refreshTarget" />
  </Page>
</template>

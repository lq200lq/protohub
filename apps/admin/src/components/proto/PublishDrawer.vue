<script setup lang="ts">
import type { DefaultOptionType } from 'ant-design-vue/es/select';
import type { ReleaseUploadForm, ReleaseUploadRefPayload } from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';
import { IconifyIcon } from '@vben/icons';
import {
  CODE_RULE,
  genPrototypeCode,
  PUBLISH_DESCRIPTION_MAX_LENGTH,
  PUBLISH_NAME_MAX_LENGTH,
  RELEASE_NOTE_MAX_LENGTH,
} from '@protohub/shared';

import {
  Button,
  Input,
  Radio,
  RadioGroup,
  Select,
  message,
} from 'ant-design-vue';
import { Textarea } from 'ant-design-vue/es/input';

import {
  checkProjectCodeApi,
  checkPrototypeCodeApi,
  getProjectsApi,
  getReleaseLinkPreviewApi,
} from '#/api';
import CopyText from '#/components/proto/CopyText.vue';
import PublishTaskPanel from '#/components/proto/PublishTaskPanel.vue';
import { codeInputHandler, useCodeCheck } from '#/composables/use-code-check';
import { $t } from '#/locales';
import { usePublishTaskStore } from '#/store';
import { publishActionOf } from '#/utils/publish-action';

defineOptions({ name: 'PublishDrawer' });

/**
 * 上传发布抽屉（前端设计 §3.4；迭代实施计划 M3-T11）。
 *
 * 三种模式**只有一份实现**：入口用 `setData({ mode, … })` 说清"新建项目+新建原型 / 已有项目+新建原型 /
 * 已有原型+发新版本"，组件里所有差异都收敛成下面那几个 `showsXxx` 派生值。
 *
 * 表单是手写控件而不是 vben form：这里不是一排输入框，而是三个带编号的区块（§3.4 分组就是为了让用户
 * 看出主次），区块 ① 还会随 Radio 换掉整组控件。
 */
const emit = defineEmits<{ reload: [] }>();

type ProjectChoice = 'existing' | 'new';
type PublishMode = 'append' | 'create' | 'newPrototype';

/** 入口传进来的全部内容：模式 + 已被锁定的归属（`newPrototype` / `append` 才带） */
interface PublishDrawerData {
  accessUrl?: string;
  mode: PublishMode;
  projectCode?: string;
  projectId?: string;
  projectName?: string;
  prototypeCode?: string;
  prototypeId?: string;
  prototypeName?: string;
}

const store = usePublishTaskStore();

const mode = ref<PublishMode>('create');
const lockedProject = ref<{ code: string; id: string; name: string } | null>(null);
const lockedPrototype = ref<{
  accessUrl: null | string;
  code: string;
  id: string;
  name: string;
} | null>(null);

const projectChoice = ref<ProjectChoice>('new');
const selectedProjectId = ref<null | string>(null);
const projectItems = ref<Array<{ code: string; id: string; name: string }>>([]);
const projectName = ref('');
const projectCode = ref('');
const prototypeName = ref('');
const prototypeCode = ref('');
const description = ref('');
const note = ref('');
const file = ref<null | File>(null);

const forceChecked = ref(false);
const formError = ref<null | string>(null);
const taskId = ref<null | string>(null);

/* ── 模式差异：全部由这几个派生值表达 ───────────────────────────────── */
const showsProjectChoice = computed(() => mode.value === 'create');
const showsProjectFields = computed(
  () => mode.value === 'create' && projectChoice.value === 'new',
);
const showsProjectReadonly = computed(
  () => mode.value === 'append' || mode.value === 'newPrototype',
);
const showsPrototypeFields = computed(() => mode.value !== 'append');
const showsPrototypeReadonly = computed(() => mode.value === 'append');

/** 这次发布挂在哪个已存在的项目下（null 表示项目也新建） */
const targetProjectId = computed(() => {
  if (mode.value !== 'create') {
    return lockedProject.value?.id ?? null;
  }
  return projectChoice.value === 'existing' ? selectedProjectId.value : null;
});

/* ── 编码：留空即"请服务端生成"，界面在提交前把生成的样子给用户看 ─────── */
const projectCheck = useCodeCheck({
  immutable: () => !showsProjectFields.value,
  query: (code) => checkProjectCodeApi(code),
});
const prototypeCheck = useCodeCheck({
  immutable: () => mode.value === 'append',
  query: (code) => checkPrototypeCodeApi(targetProjectId.value ?? '', code),
});

const selectedProject = computed(
  () =>
    projectItems.value.find((item) => item.id === selectedProjectId.value) ??
    null,
);

/** antdv Select 的 value 不接受 null（它的"没选"是 undefined），这层换算放在这里而不是散落各控件 */
const projectSelectValue = computed(() => selectedProjectId.value ?? undefined);

function onProjectSelectChange(value: unknown) {
  selectedProjectId.value = typeof value === 'string' ? value : null;
  askGeneratedPrototypeCode();
}

const effectiveProjectCode = computed(() => {
  if (mode.value !== 'create') {
    return lockedProject.value?.code ?? '';
  }
  if (projectChoice.value === 'existing') {
    return selectedProject.value?.code ?? '';
  }
  const typed = projectCode.value.trim();
  return typed === '' ? (projectCheck.generated.value ?? '') : typed;
});

/** 项目与原型编码都留空：链接会长成 `p-xxx/p-xxx-p01`，得让用户提交前就看见（§3.4） */
const bothCodesBlank = computed(
  () =>
    showsProjectFields.value &&
    projectCode.value.trim() === '' &&
    prototypeCode.value.trim() === '',
);

/**
 * 原型编码的预览值。
 *
 * 有 projectId 时问服务端（`check-code` 的 `generated` 才知道下一个序号是几）；项目也新建时无从问起，
 * 只能按"这个项目的第一个原型"给 `-p01`。真实序号在受理时才定，所以文案统一用"将生成"。
 */
const effectivePrototypeCode = computed(() => {
  if (mode.value === 'append') {
    return lockedPrototype.value?.code ?? '';
  }
  const typed = prototypeCode.value.trim();
  if (typed !== '') {
    return typed;
  }
  const generated = prototypeCheck.generated.value;
  if (generated) {
    return generated;
  }
  const project = effectiveProjectCode.value;
  return project === '' ? '' : genPrototypeCode(project, 1);
});

const bothBlankHint = computed(() =>
  bothCodesBlank.value && effectivePrototypeCode.value !== ''
    ? $t('proto.publish.bothBlankHint', [
        effectiveProjectCode.value,
        effectivePrototypeCode.value,
      ])
    : null,
);

const projectHint = computed(() =>
  !showsProjectFields.value || bothBlankHint.value !== null
    ? null
    : projectCheck.hint.value,
);

const prototypeHint = computed(() => {
  if (!showsPrototypeFields.value || bothBlankHint.value !== null) {
    return null;
  }
  if (prototypeCode.value.trim() === '') {
    return effectivePrototypeCode.value === ''
      ? null
      : $t('proto.codeCheck.generatedHint', [effectivePrototypeCode.value]);
  }
  return prototypeCheck.hint.value;
});

const codeHint = computed(() => bothBlankHint.value ?? projectHint.value ?? prototypeHint.value);
const codeHintIsError = computed(
  () => projectCheck.hintIsError.value || prototypeCheck.hintIsError.value,
);

const onProjectCodeInput = codeInputHandler((value) => {
  projectCode.value = value;
});
const onPrototypeCodeInput = codeInputHandler((value) => {
  prototypeCode.value = value;
});

async function onProjectCodeBlur() {
  if (showsProjectFields.value) {
    await projectCheck.check(projectCode.value);
  }
}

async function onPrototypeCodeBlur() {
  // 项目也新建时没有 projectId 可问，原型编码只能靠 genPrototypeCode 预览
  if (showsPrototypeFields.value && targetProjectId.value !== null) {
    await prototypeCheck.check(prototypeCode.value);
  }
}

/**
 * 项目已定、编码留空：现在就问服务端"将生成"的是哪一个，不要等失焦。
 *
 * 本地兜底给的是"该项目的第一个原型"`-p01`，而项目下已有原型时那串编码连同链接属于别人——
 * 预览于是成了一句错的承诺（§3.4「编码留空预览」）。
 */
async function askGeneratedPrototypeCode(): Promise<void> {
  if (mode.value === 'append' || targetProjectId.value === null) {
    return;
  }
  if (prototypeCode.value.trim() !== '') {
    return;
  }
  await prototypeCheck.check('');
}

/**
 * 项目也新建、编码留空：项目名一填就问服务端"将生成"的项目码，不要等失焦。
 *
 * 原型码是"项目码 + 序号"，项目码没问到时 `-p01` 也拼不出前缀，两个编码与访问链接于是全部
 * 停在占位文案——§3.4 要求的是"在提交前就看到"，默认路径又正是留空。
 */
let projectCodeAskTimer: null | ReturnType<typeof setTimeout> = null;

async function askGeneratedProjectCode(): Promise<void> {
  projectCodeAskTimer = null;
  if (
    !showsProjectFields.value ||
    projectName.value.trim() === '' ||
    projectCode.value.trim() !== ''
  ) {
    return;
  }
  await projectCheck.check('');
}

watch([projectName, projectChoice, projectCode], () => {
  if (projectCodeAskTimer !== null) {
    clearTimeout(projectCodeAskTimer);
  }
  projectCodeAskTimer = setTimeout(() => void askGeneratedProjectCode(), 300);
});

/* ── 归属项目候选（只有"新建项目 + 新建原型"要选） ───────────────────── */
const projectOptions = computed(() =>
  projectItems.value.map((item) => ({
    label: `${item.name}（${item.code}）`,
    value: item.id,
  })),
);

function filterByLabel(input: string, option?: DefaultOptionType) {
  const label = typeof option?.label === 'string' ? option.label : '';
  return label.toLowerCase().includes(input.toLowerCase());
}

async function loadProjects() {
  try {
    // 服务端 pageSize 上限 200，一期规模下一级本地过滤够用（与 PrototypePicker 同口径）
    const result = await getProjectsApi({ page: 1, pageSize: 200 });
    projectItems.value = result.items.map((item) => ({
      code: item.code,
      id: item.id,
      name: item.name,
    }));
  } catch {
    projectItems.value = [];
  }
}

/* ── 发布后的访问链接：域名拼装权在服务端，界面只换不猜（§5.9） ───────── */
const linkUrl = ref<null | string>(null);
let previewTimer: null | ReturnType<typeof setTimeout> = null;

watch(
  [effectiveProjectCode, effectivePrototypeCode],
  () => {
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    previewTimer = setTimeout(applyLinkPreview, 300);
  },
  { immediate: true },
);

async function applyLinkPreview() {
  previewTimer = null;
  if (mode.value === 'append') {
    // 链接本来就不变，直接用原型自己的访问地址，省一次请求
    linkUrl.value = lockedPrototype.value?.accessUrl ?? null;
    return;
  }
  const project = effectiveProjectCode.value;
  const prototype = effectivePrototypeCode.value;
  if (project === '' || prototype === '') {
    linkUrl.value = null;
    return;
  }
  try {
    const result = await getReleaseLinkPreviewApi(project, prototype);
    linkUrl.value = result.accessUrl;
  } catch {
    linkUrl.value = null;
  }
}

/* ── 任务进度：抽屉与浮层是同一行数据的两个视图（M3-T12） ─────────────── */
const row = computed(() => store.taskOf(taskId.value));
const inFlight = computed(() => {
  const current = row.value;
  return (
    current !== null &&
    (current.uploading ||
      current.status === 'pending' ||
      current.status === 'processing')
  );
});
const succeeded = computed(() => row.value?.status === 'success');
/** 主按钮的四种状态与上传发布页共用同一条判定（`utils/publish-action`），这里只落到抽屉底部 */
const action = computed(() => publishActionOf(row.value));

const [Drawer, drawerApi] = useVbenDrawer({
  async onConfirm() {
    if (action.value.kind === 'retry') {
      retryPublish();
      return;
    }
    await startPublish();
  },
  onOpenChange(isOpen) {
    if (isOpen) {
      resetTo(drawerApi.getData<PublishDrawerData>());
      return;
    }
    // 关抽屉不打断发布：把这一行交还给浮层，正在跑的话给用户一句说明
    store.hold(null);
    if (inFlight.value) {
      message.info($t('proto.publish.closedHandoff'));
    }
  },
});

watch(succeeded, (value) => {
  if (value) {
    emit('reload');
  }
});

/** 底部按钮随任务状态换语义：处理中不给第二个提交口，失败时「立即发布」变「重试」 */
watch(
  [action, succeeded],
  ([current, isSuccess]) => {
    drawerApi.setState({
      confirmText: $t(current.labelKey),
      showCancelButton: !isSuccess,
      showConfirmButton: current.runnable,
    });
  },
  { immediate: true },
);

function resetTo(data: PublishDrawerData) {
  mode.value = data.mode;
  lockedProject.value =
    data.projectId === undefined
      ? null
      : {
          code: data.projectCode ?? '',
          id: data.projectId,
          name: data.projectName ?? '',
        };
  lockedPrototype.value =
    data.prototypeId === undefined
      ? null
      : {
          accessUrl: data.accessUrl ?? null,
          code: data.prototypeCode ?? '',
          id: data.prototypeId,
          name: data.prototypeName ?? '',
        };
  projectChoice.value = 'new';
  selectedProjectId.value = null;
  projectItems.value = [];
  projectName.value = '';
  projectCode.value = '';
  prototypeName.value = '';
  prototypeCode.value = '';
  description.value = '';
  note.value = '';
  file.value = null;
  forceChecked.value = false;
  formError.value = null;
  linkUrl.value = null;
  taskId.value = null;
  projectCheck.reset();
  prototypeCheck.reset();
  // 重置把上一次问到的生成编码抹掉了，而项目已定（newPrototype / append 以外的锁定态），
  // 不重新问一次的话屏幕上是 `-p01` 兜底——那串编码多半属于同项目下的别的原型。
  void askGeneratedPrototypeCode();
  drawerApi.setState({
    title:
      data.mode === 'append'
        ? $t('proto.publish.appendTitle')
        : data.mode === 'newPrototype'
          ? $t('proto.publish.newPrototypeTitle')
          : $t('proto.publish.createTitle'),
  });
  if (data.mode === 'create') {
    void loadProjects();
  }
}

function refPayload(
  name: string,
  code: string,
  descriptionText: string,
): ReleaseUploadRefPayload {
  const payload: ReleaseUploadRefPayload = { name };
  if (code !== '') {
    payload.code = code;
  }
  if (descriptionText !== '') {
    payload.description = descriptionText;
  }
  return payload;
}

/** 校验 + 组装 §5.1 的三选一组合；返回 null 表示此时不该发请求 */
function buildForm(): null | ReleaseUploadForm {
  if (file.value === null) {
    return null;
  }
  if (mode.value === 'append') {
    if (lockedPrototype.value === null) {
      return null;
    }
    const text = note.value.trim();
    return {
      force: forceChecked.value ? true : undefined,
      note: text === '' ? undefined : text,
      prototypeId: lockedPrototype.value.id,
    };
  }
  const name = prototypeName.value.trim();
  if (name === '') {
    return null;
  }
  const prototype = refPayload(
    name,
    prototypeCode.value.trim(),
    description.value.trim(),
  );
  if (mode.value === 'newPrototype') {
    return targetProjectId.value === null
      ? null
      : { projectId: targetProjectId.value, prototype };
  }
  if (projectChoice.value === 'existing') {
    return selectedProjectId.value === null
      ? null
      : { projectId: selectedProjectId.value, prototype };
  }
  const project = projectName.value.trim();
  if (project === '') {
    return null;
  }
  return {
    project: refPayload(project, projectCode.value.trim(), ''),
    prototype,
  };
}

function formErrorOf(): string {
  if (file.value === null) {
    return $t('proto.publish.fileRequired');
  }
  if (mode.value === 'append') {
    return lockedPrototype.value === null
      ? $t('proto.publish.projectRequired')
      : '';
  }
  if (prototypeName.value.trim() === '') {
    return $t('proto.prototype.nameRequired');
  }
  if (mode.value === 'newPrototype') {
    return targetProjectId.value === null
      ? $t('proto.publish.projectRequired')
      : '';
  }
  if (projectChoice.value === 'existing') {
    return selectedProjectId.value === null
      ? $t('proto.publish.projectRequired')
      : '';
  }
  return projectName.value.trim() === ''
    ? $t('proto.project.nameRequired')
    : '';
}

async function startPublish() {
  const reason = formErrorOf();
  if (reason !== '') {
    formError.value = reason;
    return;
  }
  const built = buildForm();
  if (built === null || file.value === null) {
    return;
  }
  formError.value = null;
  const label = showsPrototypeFields.value
    ? prototypeName.value.trim()
    : (lockedPrototype.value?.name ?? '');
  taskId.value = store.submit({
    file: file.value,
    form: built,
    prototypeName: label,
  });
}

function retryPublish() {
  const current = row.value;
  if (current === null) {
    return;
  }
  // 勾了「强制发布」才带 force：内容重复这条判断权在服务端，界面只表达"我知道重复，仍要发"
  store.retry(current.id, { force: forceChecked.value });
}

function openLink() {
  const url = row.value?.accessUrl ?? linkUrl.value;
  if (url !== null) {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * 去原型详情。`PublishTaskPanel` 交回它自己知道的那条任务的目标原型，
 * 成功态与"还没有任务行"（比如编码新建的原型还没受理）则用抽屉锁定的归属兜底。
 * 抽屉点完导航要关掉自己，否则回到列表页还压着一层表单。
 */
function openDetail(prototypeId?: string) {
  const target =
    prototypeId ?? row.value?.prototypeId ?? lockedPrototype.value?.id ?? null;
  if (target !== null) {
    void store.goPrototypeDetail(target);
    drawerApi.close();
  }
}
</script>

<template>
  <Drawer>
    <!-- 成功态不再保留表单：那条链接就是这次发布的全部产出（§3.4） -->
    <div v-if="succeeded && row" class="space-y-4" data-testid="publish-result">
      <div class="flex items-center gap-2">
        <IconifyIcon
          class="size-7 shrink-0 text-green-600"
          icon="lucide:circle-check"
        />
        <div>
          <p class="text-base font-semibold">
            {{ $t('proto.publish.published') }}
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {{ row.prototypeName }}
          </p>
        </div>
      </div>
      <div class="space-y-1">
        <p class="text-xs text-muted-foreground">
          {{ $t('proto.publish.linkLabel') }}
        </p>
        <CopyText :max-width="420" :text="row.accessUrl ?? ''" />
      </div>
      <div class="flex flex-wrap gap-2">
        <Button type="primary" @click="openLink">
          {{ $t('proto.prototype.openLink') }}
        </Button>
        <Button @click="openDetail()">{{ $t('proto.publish.viewDetail') }}</Button>
        <Button type="link" @click="drawerApi.close()">
          {{ $t('proto.common.cancel') }}
        </Button>
      </div>
    </div>

    <div v-else class="space-y-5" data-testid="publish-form">
      <!-- ① 归属项目 -->
      <section class="space-y-2">
        <h3 class="text-sm font-semibold">
          {{ $t('proto.publish.sections.project') }}
        </h3>

        <template v-if="showsProjectChoice">
          <RadioGroup v-model:value="projectChoice">
            <Radio value="existing">
              {{ $t('proto.publish.projectMode.existing') }}
            </Radio>
            <Radio value="new">
              {{ $t('proto.publish.projectMode.new') }}
            </Radio>
          </RadioGroup>
          <Select
            v-if="projectChoice === 'existing'"
            :filter-option="filterByLabel"
            :options="projectOptions"
            :placeholder="$t('proto.picker.projectPlaceholder')"
            :value="projectSelectValue"
            class="w-full"
            show-search
            @change="onProjectSelectChange"
          />
        </template>

        <div v-if="showsProjectFields" class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-sm text-muted-foreground">
              {{ $t('proto.project.fields.name') }}
            </span>
            <Input
              v-model:value="projectName"
              :maxlength="PUBLISH_NAME_MAX_LENGTH"
              class="flex-1"
              data-testid="publish-project-name"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-sm text-muted-foreground">
              {{ $t('proto.project.fields.code') }}
            </span>
            <Input
              v-model:value="projectCode"
              :maxlength="CODE_RULE.maxLength"
              class="flex-1 font-mono"
              data-testid="publish-project-code"
              @blur="onProjectCodeBlur"
              @input="onProjectCodeInput"
            />
          </div>
        </div>

        <p v-if="showsProjectReadonly && lockedProject" class="text-sm">
          <span class="text-muted-foreground">
            {{ lockedProject.name }}（{{ lockedProject.code }}）
          </span>
        </p>
      </section>

      <!-- ② 原型信息 -->
      <section class="space-y-2">
        <h3 class="text-sm font-semibold">
          {{ $t('proto.publish.sections.prototype') }}
        </h3>

        <div v-if="showsPrototypeFields" class="space-y-2">
          <div class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-sm text-muted-foreground">
              {{ $t('proto.prototype.fields.name') }}
            </span>
            <Input
              v-model:value="prototypeName"
              :maxlength="PUBLISH_NAME_MAX_LENGTH"
              class="flex-1"
              data-testid="publish-prototype-name"
            />
          </div>
          <div class="flex items-center gap-2">
            <span class="w-20 shrink-0 text-sm text-muted-foreground">
              {{ $t('proto.prototype.fields.code') }}
            </span>
            <Input
              v-model:value="prototypeCode"
              :maxlength="CODE_RULE.maxLength"
              class="flex-1 font-mono"
              data-testid="publish-prototype-code"
              @blur="onPrototypeCodeBlur"
              @input="onPrototypeCodeInput"
            />
          </div>
          <div class="flex items-start gap-2">
            <span class="w-20 shrink-0 pt-1 text-sm text-muted-foreground">
              {{ $t('proto.prototype.fields.description') }}
            </span>
            <Textarea
              v-model:value="description"
              :maxlength="PUBLISH_DESCRIPTION_MAX_LENGTH"
              :rows="2"
              class="flex-1"
              show-count
            />
          </div>
        </div>

        <template v-if="showsPrototypeReadonly && lockedPrototype">
          <p class="text-sm">
            <span class="text-muted-foreground">
              {{ $t('proto.publish.targetPrototype') }}：
            </span>
            <span class="font-medium">
              {{ lockedPrototype.name }}（{{ lockedPrototype.code }}）
            </span>
          </p>
          <div class="flex items-start gap-2">
            <span class="w-20 shrink-0 pt-1 text-sm text-muted-foreground">
              {{ $t('proto.publish.noteLabel') }}
            </span>
            <Textarea
              v-model:value="note"
              :maxlength="RELEASE_NOTE_MAX_LENGTH"
              :placeholder="$t('proto.publish.notePlaceholder')"
              :rows="2"
              class="flex-1"
              data-testid="publish-note"
              show-count
            />
          </div>
          <p class="text-xs text-muted-foreground">
            {{ $t('proto.publish.appendHint') }}
          </p>
        </template>
      </section>

      <!-- 编码预览：两个都留空时合并成一句，免得两行灰字各说一半 -->
      <p
        v-if="codeHint"
        :class="codeHintIsError ? 'text-destructive' : 'text-muted-foreground'"
        class="text-xs"
        data-testid="publish-code-hint"
      >
        {{ codeHint }}
      </p>

      <!-- ③ 上传文件：与上传发布页 §3.6 是同一段，出口语义收在 PublishTaskPanel 一处 -->
      <section class="space-y-2">
        <h3 class="text-sm font-semibold">
          {{ $t('proto.publish.sections.file') }}
        </h3>
        <PublishTaskPanel
          v-model:file="file"
          v-model:force="forceChecked"
          :row="row"
          @go-detail="openDetail"
        />
      </section>

      <!-- 发布后访问链接 -->
      <section class="space-y-1">
        <p class="text-xs text-muted-foreground">
          {{ $t('proto.publish.linkLabel') }}
        </p>
        <CopyText
          v-if="linkUrl"
          :max-width="420"
          :text="linkUrl"
          data-testid="publish-link"
        />
        <p v-else class="text-xs text-muted-foreground">
          {{ $t('proto.publish.linkPending') }}
        </p>
      </section>

      <p
        v-if="formError"
        class="text-xs text-destructive"
        data-testid="publish-form-error"
      >
        {{ formError }}
      </p>
    </div>
  </Drawer>
</template>

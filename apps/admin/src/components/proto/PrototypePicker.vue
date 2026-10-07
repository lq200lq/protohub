<script setup lang="ts">
import type { DefaultOptionType } from 'ant-design-vue/es/select';
import type { PrototypeListItem } from '@protohub/shared';

import { ref, watch } from 'vue';

import { Select, message } from 'ant-design-vue';

import { getProjectsApi, getPrototypesApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

defineOptions({ name: 'PrototypePicker' });

/**
 * 项目→原型两级联动可搜索选择器（迭代实施计划 M2-T5）。
 * 只做"选"，不做跳转：选中后由父组件决定行为（原型详情用它切换原型，M3 发布页用它定位目标）。
 */
const emit = defineEmits<{
  pick: [payload: { projectId: string; prototype: PrototypeListItem }];
}>();

interface OptionItem {
  label: string;
  value: string;
}

const selectedProjectId = ref<null | string>(null);
const selectedPrototypeId = ref<null | string>(null);
const projectOptions = ref<OptionItem[]>([]);
/** 保留行对象：pick 时直接给父组件完整的 PrototypeListItem，不用调用方二次查询 */
const prototypeItems = ref<PrototypeListItem[]>([]);
const projectLoading = ref(false);
const prototypeLoading = ref(false);

function filterByLabel(input: string, option?: DefaultOptionType) {
  const label = typeof option?.label === 'string' ? option.label : '';
  return label.toLowerCase().includes(input.toLowerCase());
}

async function loadProjects() {
  projectLoading.value = true;
  try {
    // 服务端 pageSize 上限 200（shared PageQuery 注释），一期规模下一级本地过滤够用
    const result = await getProjectsApi({ page: 1, pageSize: 200 });
    projectOptions.value = result.items.map((item) => ({
      label: `${item.name}（${item.code}）`,
      value: item.id,
    }));
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  } finally {
    projectLoading.value = false;
  }
}

async function onProjectChange(value: unknown) {
  const projectId = typeof value === 'string' ? value : null;
  selectedProjectId.value = projectId;
  selectedPrototypeId.value = null;
  prototypeItems.value = [];
  if (!projectId) {
    return;
  }
  prototypeLoading.value = true;
  try {
    const result = await getPrototypesApi({ page: 1, pageSize: 200, projectId });
    prototypeItems.value = result.items;
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  } finally {
    prototypeLoading.value = false;
  }
}

function onPrototypeChange(value: unknown) {
  const prototypeId = typeof value === 'string' ? value : null;
  selectedPrototypeId.value = prototypeId;
  const hit = prototypeItems.value.find((item) => item.id === prototypeId);
  if (hit) {
    emit('pick', { projectId: hit.projectId, prototype: hit });
  }
}

const prototypeOptions = ref<OptionItem[]>([]);
// options 由行对象映射而来（label 带编码，便于肉眼确认没选错）
watch(prototypeItems, (items) => {
  prototypeOptions.value = items.map((item) => ({
    label: `${item.name}（${item.code}）`,
    value: item.id,
  }));
});

loadProjects();
</script>

<template>
  <div class="inline-flex items-center gap-2">
    <Select
      :filter-option="filterByLabel"
      :loading="projectLoading"
      :options="projectOptions"
      :placeholder="$t('proto.picker.projectPlaceholder')"
      class="min-w-44"
      show-search
      @change="onProjectChange"
    />
    <Select
      :disabled="!selectedProjectId"
      :filter-option="filterByLabel"
      :loading="prototypeLoading"
      :options="prototypeOptions"
      :placeholder="$t('proto.picker.prototypePlaceholder')"
      :value="selectedPrototypeId ?? undefined"
      class="min-w-44"
      show-search
      @change="onPrototypeChange"
    />
  </div>
</template>

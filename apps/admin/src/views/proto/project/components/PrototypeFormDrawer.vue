<script setup lang="ts">
import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import {
  checkPrototypeCodeApi,
  createPrototypeApi,
  getPrototypeDetailApi,
  updatePrototypeApi,
} from '#/api';
import { useCodeCheck } from '#/composables/use-code-check';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

/**
 * 原型新建/编辑抽屉：形态与项目抽屉一致（留空自动生成 `{项目码}-pNN`、失焦校验、编辑态编码只读）。
 * 数据入口只有一个：setData({ projectId, id? })——id 缺省走新建（§4.3.3），带上走编辑（§4.3.5）。
 */
defineOptions({ name: 'PrototypeFormDrawer' });

const emit = defineEmits<{ reload: [] }>();

interface FormValues {
  code?: string;
  description?: string;
  name: string;
}

const prototypeId = ref<null | string>(null);
const projectId = ref<null | string>(null);
const isEdit = computed(() => prototypeId.value !== null);

const codeCheck = useCodeCheck({
  immutable: () => isEdit.value,
  query: (code) => checkPrototypeCodeApi(projectId.value ?? '', code),
});
const { hint: codeHint, hintIsError: codeHintIsError } = codeCheck;

const [Form, formApi] = useVbenForm({
  commonConfig: { labelWidth: 90 },
  schema: [
    {
      component: 'Input',
      fieldName: 'name',
      label: $t('proto.prototype.fields.name'),
      rules: z
        .string()
        .trim()
        .min(1, { message: $t('proto.prototype.nameRequired') })
        .max(80),
    },
    {
      component: 'Input',
      componentProps: () => ({ disabled: isEdit.value, onBlur: onCodeBlur }),
      fieldName: 'code',
      label: $t('proto.prototype.fields.code'),
    },
    {
      component: 'Textarea',
      fieldName: 'description',
      label: $t('proto.prototype.fields.description'),
    },
  ],
  showDefaultActions: false,
  wrapperClass: 'grid-cols-1',
});

async function onCodeBlur() {
  if (isEdit.value || !projectId.value) {
    return;
  }
  const values = await formApi.getValues<FormValues>();
  await codeCheck.check(values.code ?? '');
}

const [Drawer, drawerApi] = useVbenDrawer({
  confirmText: $t('proto.common.save'),
  destroyOnClose: true,
  async onConfirm() {
    await handleSubmit();
  },
  async onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData<{ id?: string; projectId: string }>();
    projectId.value = data.projectId ?? null;
    prototypeId.value = data.id ?? null;
    codeCheck.reset();
    drawerApi.setState({
      title: isEdit.value
        ? $t('proto.prototype.editTitle')
        : $t('proto.prototype.createTitle'),
    });
    await formApi.resetForm();
    if (prototypeId.value) {
      await loadDetail(prototypeId.value);
    }
  },
});

async function loadDetail(id: string) {
  drawerApi.setState({ loading: true });
  try {
    const detail = await getPrototypeDetailApi(id);
    await formApi.setValues({
      code: detail.code,
      description: detail.description ?? '',
      name: detail.name,
    });
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  } finally {
    drawerApi.setState({ loading: false });
  }
}

async function handleSubmit() {
  const { valid } = await formApi.validate();
  if (!valid || !projectId.value) {
    return;
  }
  const values = await formApi.getValues<FormValues>();
  drawerApi.setState({ loading: true, submitting: true });
  try {
    if (prototypeId.value) {
      // §4.3.5：不发 code；sort 由行拖拽/详情维护，表单只有 name/description（同信息一处）
      await updatePrototypeApi(prototypeId.value, {
        description: values.description || undefined,
        name: values.name,
      });
    } else {
      await createPrototypeApi({
        code: values.code?.trim() || undefined,
        description: values.description || undefined,
        name: values.name,
        projectId: projectId.value,
      });
    }
    message.success($t('proto.common.success'));
    emit('reload');
    drawerApi.close();
  } finally {
    drawerApi.setState({ loading: false, submitting: false });
  }
}
</script>

<template>
  <Drawer>
    <Form />
    <p
      v-if="codeHint"
      :class="codeHintIsError ? 'text-destructive' : 'text-muted-foreground'"
      class="mt-1 pl-2 text-xs"
    >
      {{ codeHint }}
    </p>
  </Drawer>
</template>

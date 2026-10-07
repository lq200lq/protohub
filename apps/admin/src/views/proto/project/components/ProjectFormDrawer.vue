<script setup lang="ts">
import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import {
  checkProjectCodeApi,
  createProjectApi,
  getProjectDetailApi,
  updateProjectApi,
} from '#/api';
import { useCodeCheck } from '#/composables/use-code-check';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

/**
 * 项目新建/编辑抽屉（迭代实施计划 M2-T7，对齐用户管理同款形态）。
 * 编码可留空（失焦展示服务端将生成的编码）+ 失焦 check-code；编辑态编码只读并注"创建后不可修改"（§4.1.5）。
 */
defineOptions({ name: 'ProjectFormDrawer' });

const emit = defineEmits<{ reload: [] }>();

interface FormValues {
  code?: string;
  description?: string;
  name: string;
}

const projectId = ref<null | string>(null);
const isEdit = computed(() => projectId.value !== null);

const codeCheck = useCodeCheck({
  immutable: () => isEdit.value,
  query: (code) => checkProjectCodeApi(code),
});
const { hint: codeHint, hintIsError: codeHintIsError } = codeCheck;

const [Form, formApi] = useVbenForm({
  commonConfig: { labelWidth: 90 },
  schema: [
    {
      component: 'Input',
      fieldName: 'name',
      label: $t('proto.project.fields.name'),
      rules: z
        .string()
        .trim()
        .min(1, { message: $t('proto.project.nameRequired') })
        .max(80),
    },
    {
      component: 'Input',
      componentProps: () => ({ disabled: isEdit.value, onBlur: onCodeBlur }),
      fieldName: 'code',
      label: $t('proto.project.fields.code'),
    },
    {
      component: 'Textarea',
      fieldName: 'description',
      label: $t('proto.project.fields.description'),
    },
  ],
  showDefaultActions: false,
  wrapperClass: 'grid-cols-1',
});

/** §4.2：失焦才查（每次按键都打 check-code 没必要）；留空也查一次拿 generated 预览 */
async function onCodeBlur() {
  if (isEdit.value) {
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
    const data = drawerApi.getData<{ id?: string }>();
    projectId.value = data?.id ?? null;
    codeCheck.reset();
    drawerApi.setState({
      title: isEdit.value
        ? $t('proto.project.editTitle')
        : $t('proto.project.createTitle'),
    });
    await formApi.resetForm();
    if (projectId.value) {
      await loadDetail(projectId.value);
    }
  },
});

async function loadDetail(id: string) {
  drawerApi.setState({ loading: true });
  try {
    const detail = await getProjectDetailApi(id);
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
  if (!valid) {
    return;
  }
  const values = await formApi.getValues<FormValues>();
  drawerApi.setState({ loading: true, submitting: true });
  try {
    if (projectId.value) {
      // §4.1.5：编辑不发 code（发了也只是收到 PROTO_CODE_IMMUTABLE 警告并被忽略）
      await updateProjectApi(projectId.value, {
        description: values.description || undefined,
        name: values.name,
      });
    } else {
      await createProjectApi({
        // 留空即"请服务端生成"（D-20），空串不发，保持请求体最小
        code: values.code?.trim() || undefined,
        description: values.description || undefined,
        name: values.name,
      });
    }
    message.success($t('proto.common.success'));
    emit('reload');
    drawerApi.close();
  } catch {
    // 服务端校验失败（占用/保留字/格式）已由全局拦截器给出可读提示，这里保持抽屉打开可修正
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

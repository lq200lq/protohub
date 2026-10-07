<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { Alert, message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import {
  createSystemRoleApi,
  getSystemRoleDetailApi,
  updateSystemRoleApi,
} from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

/**
 * 角色新建/编辑抽屉（前端设计 §3.8 角色管理：列表 + 抽屉，§10.3 新建/编辑走 Drawer）。
 * 一个组件两种形态：setData 带 id 走编辑，不带走新建。
 */
defineOptions({ name: 'RoleFormDrawer' });

const emit = defineEmits<{ reload: [] }>();

interface FormValues {
  code: string;
  dataScope: 'all' | 'member' | 'own';
  name: string;
  remark?: string;
  sort?: number;
}

const roleId = ref<null | string>(null);
const builtIn = ref(false);
const isEdit = computed(() => roleId.value !== null);

const dataScopeOptions = computed(() =>
  ['all', 'member', 'own'].map((value) => ({
    label: $t(`proto.role.dataScopes.${value}`),
    value,
  })),
);

const [Form, formApi] = useVbenForm({
  commonConfig: { labelWidth: 90 },
  schema: [
    {
      component: 'Input',
      fieldName: 'name',
      label: $t('proto.role.fields.name'),
      rules: z.string().min(1, { message: $t('proto.role.fields.name') }),
    },
    {
      // C-1：内置角色的 code 不可改。置灰而不是隐藏，让人看得见为什么不能动
      component: 'Input',
      fieldName: 'code',
      label: $t('proto.role.fields.code'),
      rules: z
        .string()
        .min(1, { message: $t('proto.role.fields.code') })
        .regex(/^[a-z][a-z0-9_]{1,63}$/, {
          message: $t('proto.role.codeRule'),
        }),
    },
    {
      component: 'RadioGroup',
      componentProps: () => ({ options: dataScopeOptions.value }),
      fieldName: 'dataScope',
      label: $t('proto.role.fields.dataScope'),
    },
    {
      component: 'InputNumber',
      componentProps: { max: 9999, min: 0 },
      fieldName: 'sort',
      label: $t('proto.role.fields.sort'),
    },
    {
      component: 'Textarea',
      fieldName: 'remark',
      label: $t('proto.role.fields.remark'),
    },
  ],
  showDefaultActions: false,
  wrapperClass: 'grid-cols-1',
});

// 内置态切换时只更新 code 一个字段的可编辑性（updateSchema 不重置其它值）
watch(
  builtIn,
  (value) => {
    formApi.updateSchema([
      { componentProps: { disabled: value }, fieldName: 'code' },
    ]);
  },
  { immediate: true },
);

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
    const data = drawerApi.getData<{ builtIn?: boolean; id?: string }>();
    roleId.value = data?.id ?? null;
    builtIn.value = data?.builtIn ?? false;
    drawerApi.setState({
      title: isEdit.value
        ? $t('proto.role.editTitle')
        : $t('proto.role.createTitle'),
    });
    await formApi.resetForm();
    // 新建态的默认值与原面板一致（§7.2.3）
    await formApi.setValues({ dataScope: 'own', sort: 0 });
    if (roleId.value) {
      await loadDetail(roleId.value);
    }
  },
});

async function loadDetail(id: string) {
  drawerApi.setState({ loading: true });
  try {
    const info = await getSystemRoleDetailApi(id);
    await formApi.setValues({
      code: info.code,
      dataScope: info.dataScope,
      name: info.name,
      remark: info.remark ?? '',
      sort: info.sort,
    });
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
    // 对齐原面板的更新载荷：编码创建后由内置规则保护，不在此改
    await (roleId.value
      ? updateSystemRoleApi(roleId.value, {
          dataScope: values.dataScope,
          name: values.name,
          remark: values.remark || undefined,
          sort: values.sort,
        })
      : createSystemRoleApi({
          code: values.code,
          dataScope: values.dataScope,
          name: values.name,
          remark: values.remark || undefined,
          sort: values.sort,
        }));
    message.success($t('proto.common.success'));
    emit('reload');
    drawerApi.close();
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  } finally {
    drawerApi.setState({ loading: false, submitting: false });
  }
}
</script>

<template>
  <Drawer>
    <Alert
      v-if="builtIn"
      :message="$t('proto.role.builtInCodeTip')"
      banner
      class="mb-3"
      type="info"
    />
    <Form />
  </Drawer>
</template>

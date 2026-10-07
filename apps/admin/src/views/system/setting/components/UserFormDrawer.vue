<script setup lang="ts">
import type { UserDetail } from '@protohub/shared';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import {
  assignSystemUserRolesApi,
  createSystemUserApi,
  getSystemUserDetailApi,
  updateSystemUserApi,
} from '#/api';
import { useRoleOptions } from '#/composables/use-role-options';
import { $t } from '#/locales';

import type { OneTimePasswordPayload } from '../types';

/**
 * 用户新建/编辑抽屉（前端设计 §3.8：新建/编辑用右侧 Drawer）。
 * 一个组件承载两种形态：setData 带 id 走编辑（PUT §7.1.4），不带走新建（POST §7.1.2）。
 * 只放"创建时可填 + 系统生成"的字段（迭代实施计划 §8 F-18）；
 * username 创建后不可改（§7.1.4）所以编辑态禁用；角色改动走覆盖式的 §7.1.7。
 */
defineOptions({ name: 'UserFormDrawer' });

const emit = defineEmits<{
  /** 创建成功：一次性初始密码交给父级弹窗展示（§7.1.2） */
  created: [payload: OneTimePasswordPayload];
  reload: [];
}>();

interface FormValues {
  email?: string;
  phone?: string;
  realName: string;
  remark?: string;
  roleIds: string[];
  username: string;
}

const { hasAccessByCodes } = useAccess();

const userId = ref<null | string>(null);
const detail = ref<null | UserDetail>(null);
/** 进入抽屉时的角色快照：只有变化才调 §7.1.7，避免无谓的写操作 */
const originalRoleIds = ref<string[]>([]);

const isEdit = computed(() => userId.value !== null);
const canAssignRoles = computed(() =>
  hasAccessByCodes(['system:user:assignrole']),
);

const {
  error: roleError,
  loadRoles,
  loading: roleLoading,
  roleOptions,
} = useRoleOptions();

const [Form, formApi] = useVbenForm({
  commonConfig: { labelWidth: 110 },
  schema: [
    {
      component: 'Input',
      componentProps: () => ({ disabled: isEdit.value }),
      fieldName: 'username',
      label: $t('proto.user.fields.username'),
      rules: z
        .string()
        .min(1, { message: $t('proto.user.fields.username') })
        .regex(/^[A-Za-z0-9_.]{3,32}$/, {
          message: $t('proto.user.usernameRule'),
        }),
    },
    {
      component: 'Input',
      fieldName: 'realName',
      label: $t('proto.user.fields.realName'),
      rules: 'required',
    },
    {
      component: 'Input',
      fieldName: 'email',
      label: $t('proto.user.fields.email'),
      rules: z.string().refine(
        (value: string) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        { message: $t('proto.account.emailInvalid') },
      ),
    },
    {
      component: 'Input',
      fieldName: 'phone',
      label: $t('proto.user.fields.phone'),
    },
    {
      component: 'Select',
      componentProps: () => ({
        allowClear: true,
        loading: roleLoading.value,
        mode: 'multiple',
        options: roleOptions.value,
        placeholder: roleError.value
          ? $t('proto.common.loadFailed')
          : undefined,
      }),
      dependencies: {
        show: () => canAssignRoles.value,
        triggerFields: ['username'],
      },
      fieldName: 'roleIds',
      label: $t('proto.user.fields.roles'),
    },
    {
      component: 'Textarea',
      fieldName: 'remark',
      label: $t('proto.user.fields.remark'),
    },
  ],
  showDefaultActions: false,
  wrapperClass: 'grid-cols-1',
});

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
    userId.value = data?.id ?? null;
    detail.value = null;
    originalRoleIds.value = [];
    drawerApi.setState({
      title: isEdit.value ? $t('proto.user.editTitle') : $t('proto.user.createTitle'),
    });
    await formApi.resetForm();
    if (roleOptions.value.length === 0) {
      await loadRoles();
    }
    if (userId.value) {
      await loadDetail(userId.value);
    }
  },
});

async function loadDetail(id: string) {
  drawerApi.setState({ loading: true });
  try {
    const info = await getSystemUserDetailApi(id);
    detail.value = info;
    originalRoleIds.value = info.roles.map((role) => role.id);
    await formApi.setValues({
      email: info.email ?? '',
      phone: info.phone ?? '',
      realName: info.realName,
      remark: info.remark ?? '',
      roleIds: originalRoleIds.value,
      username: info.username,
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
  const roleIds = values.roleIds ?? [];
  drawerApi.setState({ loading: true, submitting: true });
  try {
    if (userId.value) {
      await updateSystemUserApi(userId.value, {
        email: values.email || undefined,
        phone: values.phone || undefined,
        realName: values.realName,
        remark: values.remark || undefined,
        // 启用/禁用由列表行的操作维护，抽屉里不重复暴露（同信息一处）
        status: detail.value?.status ?? 1,
      });
      if (
        canAssignRoles.value &&
        roleIds.join(',') !== originalRoleIds.value.join(',')
      ) {
        await assignSystemUserRolesApi(userId.value, { roleIds });
      }
      message.success($t('proto.common.success'));
    } else {
      const created = await createSystemUserApi({
        email: values.email || undefined,
        phone: values.phone || undefined,
        realName: values.realName,
        remark: values.remark || undefined,
        roleIds,
        username: values.username,
      });
      message.success($t('proto.common.success'));
      emit('created', {
        kind: 'created',
        password: created.initialPassword,
        username: created.username,
      });
    }
    emit('reload');
    drawerApi.close();
  } finally {
    drawerApi.setState({ loading: false, submitting: false });
  }
}
</script>

<template>
  <Drawer>
    <p v-if="!isEdit" class="text-muted-foreground mb-3 text-sm">
      {{ $t('proto.user.createPasswordTip') }}
    </p>
    <Form />
  </Drawer>
</template>

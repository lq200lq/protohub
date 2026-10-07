<script setup lang="ts">
import type { VbenFormSchema } from '#/adapter/form';

import { computed, ref } from 'vue';

import { Button } from 'ant-design-vue';

import { z } from '#/adapter/form';
import { changePasswordApi } from '#/api';
import { useVbenForm } from '#/adapter/form';
import { $t } from '#/locales';
import { validatePasswordStrength } from '#/utils/password';

defineOptions({ name: 'ChangePasswordForm' });

const emit = defineEmits<{ success: [] }>();

const submitting = ref(false);

interface PasswordFormValues {
  confirmPassword: string;
  newPassword: string;
  oldPassword: string;
}

const schema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'VbenInputPassword',
      fieldName: 'oldPassword',
      label: $t('proto.account.fields.oldPassword'),
      rules: z.string().min(1, { message: $t('proto.account.fields.oldPassword') }),
    },
    {
      component: 'VbenInputPassword',
      fieldName: 'newPassword',
      label: $t('proto.account.fields.newPassword'),
      rules: z
        .string()
        .min(1, { message: $t('proto.account.fields.newPassword') })
        .refine(validatePasswordStrength, {
          message: $t('proto.account.passwordRule'),
        }),
    },
    {
      component: 'VbenInputPassword',
      fieldName: 'confirmPassword',
      label: $t('proto.account.fields.confirmPassword'),
      dependencies: {
        rules: (values) =>
          z
            .string()
            .min(1, { message: $t('proto.account.fields.confirmPassword') })
            .refine(
              (value) => value === (values as PasswordFormValues).newPassword,
              { message: $t('proto.account.passwordMismatch') },
            ),
        triggerFields: ['newPassword'],
      },
    },
  ];
});

const [Form, formApi] = useVbenForm({
  schema: schema.value,
  showDefaultActions: false,
  commonConfig: { labelWidth: 130 },
  wrapperClass: 'grid-cols-1',
});

async function handleSubmit() {
  const { valid } = await formApi.validate();
  if (!valid) {
    return;
  }
  const values = await formApi.getValues<PasswordFormValues>();
  submitting.value = true;
  try {
    await changePasswordApi({
      newPassword: values.newPassword,
      oldPassword: values.oldPassword,
    });
    await formApi.resetForm();
    emit('success');
  } finally {
    submitting.value = false;
  }
}

/** 账号安全卡片的「取消」用：清空已输入的口令与校验态，不触发提交 */
async function resetForm() {
  await formApi.resetForm();
}

defineExpose({ handleSubmit, resetForm });
</script>

<template>
  <div>
    <Form />
    <div class="mt-2 flex justify-end">
      <Button type="primary" :loading="submitting" @click="handleSubmit">
        {{ $t('proto.common.save') }}
      </Button>
    </div>
  </div>
</template>

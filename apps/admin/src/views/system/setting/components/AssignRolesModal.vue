<script setup lang="ts">
/**
 * 分配角色弹窗（后端接口设计 §7.1.7 覆盖式提交，约束 C-4 由后端强制）。
 * 角色字典与用户抽屉共用 useRoleOptions 同一份实现，不各写一遍。
 */
import type { UserListItem } from '@protohub/shared';

import { ref } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { Checkbox, CheckboxGroup, message } from 'ant-design-vue';

import { assignSystemUserRolesApi } from '#/api';
import { useRoleOptions } from '#/composables/use-role-options';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';

defineOptions({ name: 'AssignRolesModal' });

const emit = defineEmits<{ reload: [] }>();

const target = ref<null | UserListItem>(null);
const checked = ref<string[]>([]);

const { error, loadRoles, loading, roles } = useRoleOptions();

const [Modal, modalApi] = useVbenModal({
  confirmText: $t('proto.common.save'),
  async onConfirm() {
    const user = target.value;
    if (!user) {
      return;
    }
    modalApi.setState({ loading: true, submitting: true });
    try {
      await assignSystemUserRolesApi(user.id, { roleIds: checked.value });
      message.success($t('proto.common.success'));
      emit('reload');
      modalApi.close();
    } finally {
      modalApi.setState({ loading: false, submitting: false });
    }
  },
  async onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const user = modalApi.getData<UserListItem>();
    target.value = user ?? null;
    checked.value = user ? user.roles.map((role) => role.id) : [];
    modalApi.setState({
      title: `${$t('proto.user.assignRolesTitle')} · ${user?.username ?? ''}`,
    });
    if (roles.value.length === 0) {
      await loadRoles();
    }
  },
});
</script>

<template>
  <DataState :error="error" :loading="loading" @retry="loadRoles">
    <Modal>
      <CheckboxGroup v-model:value="checked" class="w-full">
        <div class="flex flex-col gap-2">
          <label v-for="role in roles" :key="role.id" class="flex items-center gap-2">
            <Checkbox :value="role.id" />
            <span>{{ role.name }}</span>
            <span class="text-muted-foreground font-mono text-xs">
              {{ role.code }}
            </span>
          </label>
        </div>
      </CheckboxGroup>
    </Modal>
  </DataState>
</template>

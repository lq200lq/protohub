import type { RoleListItem } from '@protohub/shared';

import { computed, ref } from 'vue';

import { getSystemRolesApi } from '#/api';
import { toErrorMessage } from '#/utils/error';

/**
 * 角色下拉数据源：用户抽屉（选角色）与分配角色弹窗共用同一份实现。
 * §7.2.1 说明角色数量少、全量不分页，所以由使用方在需要时拉一次，
 * 不做全局缓存——角色授权本身是低频操作，宁可重取也不要拿到过期列表。
 */
export function useRoleOptions() {
  const roles = ref<RoleListItem[]>([]);
  const loading = ref(false);
  const error = ref<null | string>(null);

  const roleOptions = computed(() =>
    roles.value.map((role) => ({
      label: role.name,
      value: role.id,
    })),
  );

  async function loadRoles() {
    loading.value = true;
    error.value = null;
    try {
      roles.value = await getSystemRolesApi();
    } catch (caught) {
      error.value = toErrorMessage(caught);
    } finally {
      loading.value = false;
    }
  }

  return { error, loadRoles, loading, roleOptions, roles };
}

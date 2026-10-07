<script setup lang="ts">
import type { PermissionCode } from '@protohub/shared';
import type { DataNode } from 'ant-design-vue/es/tree';

import { ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message, Tree } from 'ant-design-vue';

import {
  assignRolePermissionsApi,
  getMenuTreeApi,
  getPermissionDictApi,
  getSystemRoleDetailApi,
} from '#/api';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import { menuTreeToCheckableTree } from '#/utils/menu-tree';
import {
  extractPermissionCodes,
  permissionGroupsToTree,
} from '#/utils/permission-tree';

/**
 * 权限授权抽屉（前端设计 §3.8：点操作列「权限」打开）。
 * 两棵树：权限码按模块分组 + 菜单树（button 节点排除——按钮权限走权限码勾选），
 * 提交走 §7.2.6 的覆盖式授权。
 */
defineOptions({ name: 'RolePermDrawer' });

const emit = defineEmits<{ reload: [] }>();

const roleId = ref<null | string>(null);
const loading = ref(false);
const loadError = ref<null | string>(null);

const permissionTree = ref<DataNode[]>([]);
const menuTree = ref<DataNode[]>([]);
const checkedPermissions = ref<string[]>([]);
const checkedMenus = ref<string[]>([]);

/** checkStrictly 下 antd 可能回传 {checked,halfChecked}，统一收成数组 */
function normalizeChecked(
  payload: (number | string)[] | null | { checked: (number | string)[] },
): string[] {
  if (!payload) {
    return [];
  }
  const keys = Array.isArray(payload) ? payload : payload.checked;
  return keys.map(String);
}

async function loadAll() {
  if (!roleId.value) {
    return;
  }
  loading.value = true;
  loadError.value = null;
  try {
    const [info, groups, menuNodes] = await Promise.all([
      getSystemRoleDetailApi(roleId.value),
      getPermissionDictApi(),
      getMenuTreeApi(),
    ]);
    checkedPermissions.value = [...info.permissionCodes];
    checkedMenus.value = [...info.menuIds];
    permissionTree.value = permissionGroupsToTree(groups, (module) =>
      $t(`proto.role.modules.${module}`),
    );
    menuTree.value = menuTreeToCheckableTree(menuNodes, {
      excludeButtons: true,
    });
  } catch (error) {
    loadError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    loading.value = false;
  }
}

const [Drawer, drawerApi] = useVbenDrawer({
  confirmText: $t('proto.role.savePermissions'),
  destroyOnClose: true,
  async onConfirm() {
    await handleSave();
  },
  async onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData<{ id: string; name: string }>();
    roleId.value = data?.id ?? null;
    drawerApi.setState({
      title: $t('proto.role.permDrawerTitle', [data?.name ?? '']),
    });
    checkedPermissions.value = [];
    checkedMenus.value = [];
    await loadAll();
  },
});

async function handleSave() {
  if (!roleId.value) {
    return;
  }
  drawerApi.setState({ loading: true, submitting: true });
  try {
    await assignRolePermissionsApi(roleId.value, {
      menuIds: checkedMenus.value,
      // 树上勾到的 group:xxx 与残留 key 在这里被过滤成真实权限码
      permissionCodes: extractPermissionCodes(
        checkedPermissions.value,
      ) as PermissionCode[],
    });
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
    <DataState :error="loadError" :loading="loading" @retry="loadAll">
      <div class="grid gap-4 lg:grid-cols-2">
        <div>
          <p class="mb-1 font-medium">
            {{ $t('proto.role.permissionsTitle') }}
          </p>
          <Tree
            :checked-keys="checkedPermissions"
            :selectable="false"
            :tree-data="permissionTree"
            check-strictly
            checkable
            default-expand-all
            @check="checkedPermissions = normalizeChecked($event)"
          />
        </div>
        <div>
          <p class="mb-1 font-medium">{{ $t('proto.role.menuTitle') }}</p>
          <Tree
            :checked-keys="checkedMenus"
            :selectable="false"
            :tree-data="menuTree"
            check-strictly
            checkable
            default-expand-all
            @check="checkedMenus = normalizeChecked($event)"
          />
        </div>
      </div>
    </DataState>
  </Drawer>
</template>

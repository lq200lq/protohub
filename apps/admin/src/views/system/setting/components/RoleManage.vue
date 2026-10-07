<script setup lang="ts">
import type { RoleListItem } from '@protohub/shared';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer } from '@vben/common-ui';

import { Alert, Button, Dropdown, Menu, MenuItem, message, Modal } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { deleteSystemRoleApi, getSystemRolesApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

import RoleFormDrawer from './RoleFormDrawer.vue';
import RolePermDrawer from './RolePermDrawer.vue';

defineOptions({ name: 'RoleManage' });

/**
 * 角色管理（前端设计 §3.8：角色列表；§10.3 新建/编辑/授权一律走 Drawer）。
 * 操作列：「权限」按钮开授权抽屉，编辑/删除收进「⋯」下拉；
 * 基本信息与授权拆在两个抽屉里，互不混装。
 */
const { hasAccessByCodes } = useAccess();

interface RowMenuItem {
  danger?: boolean;
  disabled?: boolean;
  key: string;
  label: string;
}

const canCreate = computed(() => hasAccessByCodes(['system:role:create']));
const canUpdate = computed(() => hasAccessByCodes(['system:role:update']));
const canDelete = computed(() => hasAccessByCodes(['system:role:delete']));
const canAssignPerm = computed(() =>
  hasAccessByCodes(['system:role:assignperm']),
);

/* 一个能力一个组件：表单抽屉与授权抽屉各自独立（同 UserManage 的组织方式） */
const [RoleForm, roleFormApi] = useVbenDrawer({
  connectedComponent: RoleFormDrawer,
});
const [RolePerm, rolePermApi] = useVbenDrawer({
  connectedComponent: RolePermDrawer,
});

const [Grid, gridApi] = useVbenVxeGrid<RoleListItem>({
  gridOptions: {
    columns: [
      {
        field: 'name',
        minWidth: 120,
        slots: { default: 'name' },
        title: $t('proto.role.columns.name'),
      },
      {
        // L4：编码是辅助识别信息，等宽 + 次级色
        field: 'code',
        minWidth: 130,
        slots: { default: 'code' },
        title: $t('proto.role.columns.code'),
      },
      {
        field: 'userCount',
        title: $t('proto.role.columns.userCount'),
        width: 90,
      },
      {
        field: 'dataScope',
        minWidth: 100,
        slots: { default: 'dataScope' },
        title: $t('proto.role.columns.dataScope'),
      },
      {
        field: 'action',
        fixed: 'right',
        slots: { default: 'action' },
        title: $t('proto.common.action'),
        width: 140,
      },
    ],
    height: 'auto',
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async () => {
          try {
            const roles = await getSystemRolesApi();
            loadError.value = null;
            return { items: roles, total: roles.length };
          } catch (error) {
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true },
  } as VxeTableGridOptions<RoleListItem>,
});

const loadError = ref<null | string>(null);

function onCreate() {
  roleFormApi.setData({});
  roleFormApi.open();
}

function onEdit(row: RoleListItem) {
  roleFormApi.setData({ builtIn: row.builtIn, id: row.id });
  roleFormApi.open();
}

function onAssignPermissions(row: RoleListItem) {
  rolePermApi.setData({ id: row.id, name: row.name });
  rolePermApi.open();
}

function onDelete(row: RoleListItem) {
  Modal.confirm({
    content: $t('proto.role.deleteConfirm', [row.name]),
    okType: 'danger',
    onOk: async () => {
      await deleteSystemRoleApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.delete'),
  });
}

/** 行内除「权限」外的操作收进一个「⋯」Dropdown（前端设计 §10.3），按权限码过滤 */
function rowMenus(row: RoleListItem): RowMenuItem[] {
  const items: (false | null | RowMenuItem)[] = [
    canUpdate.value && { key: 'edit', label: $t('proto.common.edit') },
    canDelete.value && {
      danger: true,
      disabled: row.builtIn,
      key: 'delete',
      label: $t('proto.common.delete'),
    },
  ];
  return items.filter(
    (item): item is RowMenuItem => item !== false && item !== null,
  );
}

function onMenuClick(row: RoleListItem, info: { key: number | string }) {
  switch (info.key) {
    case 'delete': {
      onDelete(row);
      break;
    }
    case 'edit': {
      onEdit(row);
      break;
    }
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-2">
    <Alert v-if="loadError" :message="loadError" banner type="error">
      <template #action>
        <Button size="small" @click="gridApi.query()">
          {{ $t('proto.common.retry') }}
        </Button>
      </template>
    </Alert>

    <Grid class="min-h-0 flex-1">
      <template #toolbar-tools>
        <Button v-if="canCreate" type="primary" @click="onCreate">
          {{ $t('proto.common.create') }}
        </Button>
      </template>

      <template #name="{ row }">
        <span class="font-semibold">{{ row.name }}</span>
        <span v-if="row.builtIn" class="text-muted-foreground ml-1 text-xs">
          {{ $t('proto.role.builtIn') }}
        </span>
      </template>

      <template #code="{ row }">
        <span class="text-muted-foreground font-mono text-[13px]">
          {{ row.code }}
        </span>
      </template>

      <template #dataScope="{ row }">
        {{ $t(`proto.role.dataScopes.${row.dataScope}`) }}
      </template>

      <template #action="{ row }">
        <div class="flex items-center gap-1">
          <Button
            v-if="canAssignPerm"
            size="small"
            type="link"
            @click.stop="onAssignPermissions(row)"
          >
            {{ $t('proto.role.permAction') }}
          </Button>
          <Dropdown v-if="canUpdate || canDelete" :trigger="['click']">
            <Button size="small" type="text">⋯</Button>
            <template #overlay>
              <Menu @click="onMenuClick(row, $event)">
                <MenuItem
                  v-for="item in rowMenus(row)"
                  :key="item.key"
                  :danger="item.danger"
                  :disabled="item.disabled"
                >
                  {{ item.label }}
                </MenuItem>
              </Menu>
            </template>
          </Dropdown>
        </div>
      </template>
    </Grid>

    <RoleForm @reload="gridApi.query()" />
    <RolePerm @reload="gridApi.query()" />
  </div>
</template>

<script setup lang="ts">
import type { RoleListItem } from '@protohub/shared';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Alert, Button, Modal, message } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { deleteSystemRoleApi, getMenuTreeApi, getSystemRolesApi } from '#/api';
import { $t } from '#/locales';
import { menuTreeToCheckableTree } from '#/utils/menu-tree';
import { toErrorMessage } from '#/utils/error';

import RoleDetailPanel from './RoleDetailPanel.vue';

defineOptions({ name: 'RoleManage' });

/**
 * 角色管理 Tab：左列表 + 右配置面板（前端设计 §3.8）。
 * 新建与编辑都走右侧同一个面板（RoleDetailPanel 的两种形态），
 * 列表只负责选中与删除，避免出现两份"角色基本信息"表单。
 */
const { hasAccessByCodes } = useAccess();

const selected = ref<null | RoleListItem>(null);
const menuTree = ref<ReturnType<typeof menuTreeToCheckableTree>>([]);
const loadError = ref<null | string>(null);

const canCreate = computed(() => hasAccessByCodes(['system:role:create']));
const canDelete = computed(() => hasAccessByCodes(['system:role:delete']));

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
        width: 80,
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
            if (selected.value) {
              const stillThere = roles.find(
                (role) => role.id === selected.value?.id,
              );
              selected.value = stillThere ?? roles[0] ?? null;
            } else {
              selected.value = roles[0] ?? null;
            }
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
  gridEvents: {
    cellClick: ({ row }: { row: RoleListItem }) => {
      selected.value = row;
    },
  },
});

/** 授权用的菜单树：排除 button 节点（按钮权限走权限码勾选） */
async function loadMenuTree() {
  const tree = await getMenuTreeApi();
  menuTree.value = menuTreeToCheckableTree(tree, { excludeButtons: true });
}

onMounted(loadMenuTree);

function onCreate() {
  selected.value = null;
}

function onDelete(row: RoleListItem) {
  Modal.confirm({
    content: $t('proto.role.deleteConfirm', [row.name]),
    okType: 'danger',
    onOk: async () => {
      await deleteSystemRoleApi(row.id);
      message.success($t('proto.common.success'));
      selected.value = null;
      gridApi.query();
    },
    title: $t('proto.common.delete'),
  });
}

function onCreated(role: RoleListItem) {
  selected.value = role;
  gridApi.query();
}
</script>

<template>
  <div>
    <Alert v-if="loadError" :message="loadError" banner type="error">
      <template #action>
        <Button size="small" @click="gridApi.query()">
          {{ $t('proto.common.retry') }}
        </Button>
      </template>
    </Alert>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Grid>
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
          <Button
            v-if="canDelete"
            :disabled="row.builtIn"
            danger
            size="small"
            type="link"
            @click.stop="onDelete(row)"
          >
            {{ $t('proto.common.delete') }}
          </Button>
        </template>
      </Grid>

      <RoleDetailPanel
        :menu-tree="menuTree"
        :role="selected"
        @created="onCreated"
        @reloaded="gridApi.query()"
      />
    </div>
  </div>
</template>

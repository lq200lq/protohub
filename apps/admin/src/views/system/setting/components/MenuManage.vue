<script setup lang="ts">
import type { MenuTreeNode } from '@protohub/shared';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer } from '@vben/common-ui';

import { Alert, Button, Modal, Tag, message } from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { deleteMenuApi, getMenuTreeApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import { flattenMenuTree } from '#/utils/menu-tree';

import MenuFormDrawer from './MenuFormDrawer.vue';

defineOptions({ name: 'MenuManage' });

/**
 * 菜单管理 Tab（前端设计 §3.8）：树形表格 + 抽屉编辑。
 * §7.3.1 返回的是树且不分页，所以用 vxe 的 treeConfig.transform 把
 * flattenMenuTree 的扁平行还原成树（父子关系靠 id/pid），避免自己写一套展开逻辑。
 */
const { hasAccessByCodes } = useAccess();

const loadError = ref<null | string>(null);
/** 原始树：抽屉的父级候选与"编辑回填"都要用它（§7.3 没有单条详情接口） */
const tree = ref<MenuTreeNode[]>([]);

const canCreate = computed(() => hasAccessByCodes(['system:menu:create']));
const canUpdate = computed(() => hasAccessByCodes(['system:menu:update']));
const canDelete = computed(() => hasAccessByCodes(['system:menu:delete']));

const [Drawer, drawerApi] = useVbenDrawer({
  connectedComponent: MenuFormDrawer,
});

const [Grid, gridApi] = useVbenVxeGrid<MenuTreeNode>({
  gridOptions: {
    columns: [
      {
        field: 'title',
        minWidth: 220,
        slots: { default: 'title' },
        title: $t('proto.menu.columns.title'),
        treeNode: true,
      },
      {
        field: 'type',
        slots: { default: 'type' },
        title: $t('proto.menu.columns.type'),
        width: 90,
      },
      {
        field: 'path',
        minWidth: 160,
        slots: { default: 'path' },
        title: $t('proto.menu.columns.path'),
      },
      {
        field: 'component',
        minWidth: 180,
        title: $t('proto.menu.columns.component'),
      },
      {
        field: 'authCode',
        minWidth: 170,
        title: $t('proto.menu.columns.authCode'),
      },
      {
        field: 'sort',
        title: $t('proto.common.sort'),
        width: 70,
      },
      {
        field: 'status',
        slots: { default: 'status' },
        title: $t('proto.common.status'),
        width: 90,
      },
      {
        field: 'action',
        fixed: 'right',
        slots: { default: 'action' },
        title: $t('proto.common.action'),
        width: 170,
      },
    ],
    height: 'auto',
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async () => {
          try {
            const nodes = await getMenuTreeApi();
            tree.value = nodes;
            loadError.value = null;
            const rows = flattenMenuTree(nodes);
            return { items: rows, total: rows.length };
          } catch (error) {
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    treeConfig: {
      children: 'children',
      parentField: 'pid',
      rowField: 'id',
      transform: true,
    },
  },
});

function onCreate(pid?: string) {
  drawerApi.setData({ pid, tree: tree.value });
  drawerApi.open();
}

function onEdit(row: MenuTreeNode) {
  drawerApi.setData({ id: row.id, tree: tree.value });
  drawerApi.open();
}

/** 新增子项：按钮只能挂在菜单下，所以预置 type 由父级类型决定 */
function onAddChild(row: MenuTreeNode) {
  drawerApi.setData({
    pid: row.id,
    presetType: row.type === 'catalog' ? 'menu' : 'button',
    tree: tree.value,
  });
  drawerApi.open();
}

function onDelete(row: MenuTreeNode) {
  Modal.confirm({
    content: $t('proto.menu.deleteConfirm', [row.title]),
    okType: 'danger',
    onOk: async () => {
      await deleteMenuApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.delete'),
  });
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
        <Button v-if="canCreate" type="primary" @click="onCreate()">
          {{ $t('proto.common.create') }}
        </Button>
      </template>

      <!-- L3：菜单名是一行里唯一的重元素 -->
      <template #title="{ row }">
        <span class="font-semibold">{{ row.title }}</span>
      </template>

      <template #type="{ row }">
        <Tag>{{ $t(`proto.menu.types.${row.type}`) }}</Tag>
      </template>

      <template #path="{ row }">
        <span class="text-muted-foreground font-mono text-[13px]">
          {{ row.path ?? '—' }}
        </span>
      </template>

      <template #status="{ row }">
        <Tag :color="row.status === 1 ? 'green' : 'default'">
          {{
            row.status === 1
              ? $t('proto.common.enabled')
              : $t('proto.common.disabled')
          }}
        </Tag>
      </template>

      <template #action="{ row }">
        <Button
          v-if="canCreate"
          size="small"
          type="link"
          @click="onAddChild(row)"
        >
          {{ $t('proto.menu.addChild') }}
        </Button>
        <Button
          v-if="canUpdate"
          size="small"
          type="link"
          @click="onEdit(row)"
        >
          {{ $t('proto.common.edit') }}
        </Button>
        <Button
          v-if="canDelete"
          danger
          size="small"
          type="link"
          @click="onDelete(row)"
        >
          {{ $t('proto.common.delete') }}
        </Button>
      </template>
    </Grid>

    <Drawer @reload="gridApi.query()" />
  </div>
</template>

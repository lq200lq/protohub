<script setup lang="ts">
import type { UserListItem, UserStatus } from '@protohub/shared';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { useVbenDrawer, useVbenModal } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';
import { useUserStore } from '@vben/stores';

import {
  Alert,
  Button,
  Dropdown,
  Menu,
  MenuItem,
  Modal,
  Space,
  Tag,
  message,
} from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import {
  deleteSystemUserApi,
  getSystemUserDetailApi,
  getSystemUsersApi,
  resetSystemUserPasswordApi,
  updateSystemUserApi,
} from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

import AssignRolesModal from './AssignRolesModal.vue';
import OneTimePasswordModal from './OneTimePasswordModal.vue';
import UserFormDrawer from './UserFormDrawer.vue';

defineOptions({ name: 'UserManage' });

/** useVbenVxeGrid 不给 query 回调上下文类型，这里显式标注代理参数（vxe 分页上下文 + 筛选表单值） */
interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
}
interface UserFilterFormValues {
  keyword?: string;
  status?: UserStatus;
}

interface RowMenuItem {
  danger?: boolean;
  disabled?: boolean;
  key: string;
  label: string;
}

const { hasAccessByCodes } = useAccess();
const userStore = useUserStore();

const loadError = ref<null | string>(null);

/* 一个能力一个组件：新建/编辑抽屉、分配角色、一次性密码各自独立 */
const [UserDrawer, userDrawerApi] = useVbenDrawer({
  connectedComponent: UserFormDrawer,
});
const [RolesModal, rolesModalApi] = useVbenModal({
  connectedComponent: AssignRolesModal,
});
const [PasswordModal, passwordModalApi] = useVbenModal({
  connectedComponent: OneTimePasswordModal,
});

const canCreate = computed(() => hasAccessByCodes(['system:user:create']));
const canUpdate = computed(() => hasAccessByCodes(['system:user:update']));
const canDelete = computed(() => hasAccessByCodes(['system:user:delete']));
const canResetPwd = computed(() =>
  hasAccessByCodes(['system:user:resetpwd']),
);
const canAssignRole = computed(() =>
  hasAccessByCodes(['system:user:assignrole']),
);

const [Grid, gridApi] = useVbenVxeGrid<UserListItem>({
  formOptions: {
    schema: [
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.user.filter.keywordPlaceholder'),
        },
        fieldName: 'keyword',
        label: $t('proto.user.columns.username'),
      },
      {
        component: 'Select',
        componentProps: {
          allowClear: true,
          options: [
            { label: $t('proto.common.enabled'), value: 1 },
            { label: $t('proto.common.disabled'), value: 0 },
          ],
        },
        fieldName: 'status',
        label: $t('proto.common.status'),
      },
    ],
    submitOnChange: true,
    wrapperClass: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
  },
  gridOptions: {
    columns: [
      {
        field: 'username',
        minWidth: 150,
        slots: { default: 'username' },
        title: $t('proto.user.columns.username'),
      },
      {
        field: 'realName',
        minWidth: 100,
        title: $t('proto.user.columns.realName'),
      },
      {
        field: 'email',
        minWidth: 180,
        title: $t('proto.user.columns.email'),
      },
      {
        field: 'roles',
        minWidth: 180,
        slots: { default: 'roles' },
        title: $t('proto.user.columns.roles'),
      },
      {
        field: 'status',
        slots: { default: 'status' },
        title: $t('proto.common.status'),
        width: 90,
      },
      {
        field: 'lastLoginAt',
        minWidth: 165,
        slots: { default: 'lastLoginAt' },
        title: $t('proto.user.columns.lastLoginAt'),
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
    proxyConfig: {
      ajax: {
        query: async (
          { page }: ProxyQueryArgs,
          formValues: null | UserFilterFormValues | undefined,
        ) => {
          try {
            const result = await getSystemUsersApi({
              keyword: formValues?.keyword || undefined,
              page: page.currentPage,
              pageSize: page.pageSize,
              status: formValues?.status,
            });
            loadError.value = null;
            return result;
          } catch (error) {
            // §10.2：请求失败保留上一份数据 + 可重试，这里只记录错误并交回 vxe
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true },
  },
});

/** 当前登录用户：前端预防性禁用（后端 C-2/C-3 才是真约束） */
function isSelf(row: UserListItem) {
  return row.id === userStore.userInfo?.userId;
}

function onCreate() {
  userDrawerApi.setData({});
  userDrawerApi.open();
}

function onEdit(row: UserListItem) {
  userDrawerApi.setData({ id: row.id });
  userDrawerApi.open();
}

function onAssignRoles(row: UserListItem) {
  rolesModalApi.setData(row);
  rolesModalApi.open();
}

function onToggleStatus(row: UserListItem) {
  const next = row.status === 1 ? 0 : 1;
  const nextLabel =
    next === 1 ? $t('proto.common.enabled') : $t('proto.common.disabled');
  Modal.confirm({
    content: $t('proto.user.toggleConfirm', [nextLabel, row.username]),
    onOk: async () => {
      // §7.1.4 是整量更新，而列表行里没有 remark：先取详情再回写，避免把备注冲掉
      const detail = await getSystemUserDetailApi(row.id);
      await updateSystemUserApi(row.id, {
        email: detail.email ?? undefined,
        phone: detail.phone ?? undefined,
        realName: detail.realName,
        remark: detail.remark ?? undefined,
        status: next,
      });
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.confirm'),
  });
}

function onResetPassword(row: UserListItem) {
  Modal.confirm({
    content: $t('proto.user.resetPasswordConfirm', [row.username]),
    onOk: async () => {
      const result = await resetSystemUserPasswordApi(row.id);
      passwordModalApi.setData({
        kind: 'reset',
        password: result.newPassword,
        username: row.username,
      });
      passwordModalApi.open();
    },
    title: $t('proto.user.resetPassword'),
  });
}

function onDelete(row: UserListItem) {
  Modal.confirm({
    content: $t('proto.user.deleteConfirm', [row.username]),
    okType: 'danger',
    onOk: async () => {
      await deleteSystemUserApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.user.deleteAction'),
  });
}

/** 行操作收进一个「⋯」Dropdown（前端设计 §10.3），并按权限码过滤 */
function rowMenus(row: UserListItem): RowMenuItem[] {
  const items: (RowMenuItem | false | null)[] = [
    canUpdate.value && { key: 'edit', label: $t('proto.common.edit') },
    canAssignRole.value && {
      key: 'roles',
      label: $t('proto.user.assignRolesTitle'),
    },
    canResetPwd.value && {
      key: 'resetPwd',
      label: $t('proto.user.resetPassword'),
    },
    canUpdate.value && {
      disabled: isSelf(row),
      key: 'toggle',
      label:
        row.status === 1
          ? $t('proto.common.disabled')
          : $t('proto.common.enabled'),
    },
    canDelete.value && {
      danger: true,
      disabled: row.builtIn || isSelf(row),
      key: 'delete',
      label: $t('proto.user.deleteAction'),
    },
  ];
  return items.filter((item): item is RowMenuItem => Boolean(item));
}

function onMenuClick(row: UserListItem, info: { key: number | string }) {
  switch (info.key) {
    case 'delete': {
      onDelete(row);
      break;
    }
    case 'edit': {
      onEdit(row);
      break;
    }
    case 'resetPwd': {
      onResetPassword(row);
      break;
    }
    case 'roles': {
      onAssignRoles(row);
      break;
    }
    case 'toggle': {
      onToggleStatus(row);
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

      <!-- L3：一行里唯一的重元素；内置账号带标记（后端接口设计 §7.1.2 的 builtIn） -->
      <template #username="{ row }">
        <span class="font-semibold">{{ row.username }}</span>
        <Tag v-if="row.builtIn" class="ml-1">{{ $t('proto.user.builtIn') }}</Tag>
      </template>

      <template #roles="{ row }">
        <Space :size="4" wrap>
          <Tag v-for="role in row.roles" :key="role.id">{{ role.name }}</Tag>
          <span v-if="row.roles.length === 0" class="text-muted-foreground">
            —
          </span>
        </Space>
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

      <!-- L4：时间是次级信息，用次级文本色 -->
      <template #lastLoginAt="{ row }">
        <span class="text-muted-foreground text-[13px]">
          {{ formatDateTime(row.lastLoginAt ?? undefined) || '—' }}
        </span>
      </template>

      <template #action="{ row }">
        <Dropdown :trigger="['click']">
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
      </template>
    </Grid>

    <UserDrawer @created="passwordModalApi.setData($event); passwordModalApi.open()" @reload="gridApi.query()" />
    <RolesModal @reload="gridApi.query()" />
    <PasswordModal />
  </div>
</template>

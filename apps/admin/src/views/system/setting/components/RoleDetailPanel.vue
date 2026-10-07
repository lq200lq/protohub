<script setup lang="ts">
import type { DataNode } from 'ant-design-vue/es/tree';

import type { PermissionCode, RoleDetail, RoleListItem } from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';

import { Alert, Button, Card, Tree, message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import {
  assignRolePermissionsApi,
  createSystemRoleApi,
  getPermissionDictApi,
  getSystemRoleDetailApi,
  updateSystemRoleApi,
} from '#/api';
import DataState from '#/components/common/DataState.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import {
  extractPermissionCodes,
  permissionGroupsToTree,
} from '#/utils/permission-tree';

/**
 * 角色配置面板（前端设计 §3.8 角色管理：左列表 + 右配置）。
 * 一个组件同时承载"新建角色"与"编辑角色"：role 为 null 即新建态（§7.2.3），
 * 否则拉 §7.2.2 详情回填。授权提交（§7.2.6）需要角色 id，所以只编辑态展示。
 */
defineOptions({ name: 'RoleDetailPanel' });

const props = defineProps<{
  /** 菜单勾选树（父级统一拉取，button 节点已排除） */
  menuTree: DataNode[];
  /** null = 新建态 */
  role: null | RoleListItem;
}>();

const emit = defineEmits<{
  created: [role: RoleListItem];
  reloaded: [];
}>();

const { hasAccessByCodes } = useAccess();

const detail = ref<null | RoleDetail>(null);
const loadingDetail = ref(false);
const detailError = ref<null | string>(null);

const permissionTree = ref<DataNode[]>([]);
const loadingPermissions = ref(false);
const permissionError = ref<null | string>(null);

const checkedPermissions = ref<string[]>([]);
const checkedMenus = ref<string[]>([]);

const isCreate = computed(() => props.role === null);
const builtIn = computed(() => props.role?.builtIn ?? false);
const canCreate = computed(() => hasAccessByCodes(['system:role:create']));
const canUpdate = computed(() => hasAccessByCodes(['system:role:update']));
const canAssignPerm = computed(() =>
  hasAccessByCodes(['system:role:assignperm']),
);
const showBasicForm = computed(
  () => isCreate.value ? canCreate.value : canUpdate.value,
);

const dataScopeOptions = computed(() =>
  ['all', 'member', 'own'].map((value) => ({
    label: $t(`proto.role.dataScopes.${value}`),
    value,
  })),
);

const [BasicForm, basicFormApi] = useVbenForm({
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
      componentProps: { options: dataScopeOptions.value },
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
    basicFormApi.updateSchema([
      { componentProps: { disabled: value }, fieldName: 'code' },
    ]);
  },
  { immediate: true },
);

watch(
  () => props.role,
  async (role) => {
    if (!role) {
      detail.value = null;
      checkedPermissions.value = [];
      checkedMenus.value = [];
      await basicFormApi.resetForm();
      await basicFormApi.setValues({ dataScope: 'own', sort: 0 });
      return;
    }
    await loadDetail(role.id);
  },
  { immediate: true },
);

async function loadDetail(id: string) {
  loadingDetail.value = true;
  detailError.value = null;
  try {
    const info = await getSystemRoleDetailApi(id);
    detail.value = info;
    await basicFormApi.setValues({
      code: info.code,
      dataScope: info.dataScope,
      name: info.name,
      remark: info.remark ?? '',
      sort: info.sort,
    });
    checkedPermissions.value = [...info.permissionCodes];
    checkedMenus.value = [...info.menuIds];
  } catch (error) {
    detailError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    loadingDetail.value = false;
  }
}

async function loadPermissionDict() {
  loadingPermissions.value = true;
  permissionError.value = null;
  try {
    const groups = await getPermissionDictApi();
    permissionTree.value = permissionGroupsToTree(groups, (module) =>
      $t(`proto.role.modules.${module}`),
    );
  } catch (error) {
    permissionError.value =
      toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    loadingPermissions.value = false;
  }
}

watch(
  canAssignPerm,
  (allowed) => {
    if (allowed && permissionTree.value.length === 0) {
      loadPermissionDict();
    }
  },
  { immediate: true },
);

/** checkStrictly 下 antd 可能回传 {checked,halfChecked}，统一收成数组 */
function normalizeChecked(
  payload: null | { checked: (number | string)[] } | (number | string)[],
): string[] {
  if (!payload) {
    return [];
  }
  const keys = Array.isArray(payload) ? payload : payload.checked;
  return keys.map(String);
}

interface BasicFormValues {
  code: string;
  dataScope: 'all' | 'member' | 'own';
  name: string;
  remark?: string;
  sort?: number;
}

async function handleSaveBasic() {
  const { valid } = await basicFormApi.validate();
  if (!valid) {
    return;
  }
  const values = await basicFormApi.getValues<BasicFormValues>();
  try {
    if (isCreate.value) {
      const created = await createSystemRoleApi({
        code: values.code,
        dataScope: values.dataScope,
        name: values.name,
        remark: values.remark || undefined,
        sort: values.sort,
      });
      message.success($t('proto.common.success'));
      emit('created', created);
      return;
    }
    if (props.role) {
      await updateSystemRoleApi(props.role.id, {
        dataScope: values.dataScope,
        name: values.name,
        remark: values.remark || undefined,
        sort: values.sort,
      });
      message.success($t('proto.common.success'));
      emit('reloaded');
    }
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  }
}

async function handleSavePermissions() {
  const role = props.role;
  if (!role) {
    return;
  }
  try {
    await assignRolePermissionsApi(role.id, {
      menuIds: checkedMenus.value,
      // 树上勾到的 group:xxx 与残留 key 在这里被过滤成真实权限码
      permissionCodes: extractPermissionCodes(
        checkedPermissions.value,
      ) as PermissionCode[],
    });
    message.success($t('proto.common.success'));
    emit('reloaded');
  } catch (error) {
    message.error(toErrorMessage(error) || $t('proto.common.loadFailed'));
  }
}
</script>

<template>
  <Card
    size="small"
    :title="
      isCreate
        ? $t('proto.role.createTitle')
        : `${$t('proto.role.listTitle')}：${role?.name ?? ''}`
    "
  >
    <Alert
      v-if="builtIn"
      :message="$t('proto.role.builtInCodeTip')"
      banner
      class="mb-3"
      type="info"
    />

    <DataState
      :error="detailError"
      :loading="loadingDetail"
      @retry="role && loadDetail(role.id)"
    >
      <BasicForm />
      <div v-if="showBasicForm" class="mt-2 flex justify-end">
        <Button type="primary" @click="handleSaveBasic">
          {{ isCreate ? $t('proto.common.create') : $t('proto.role.saveBasic') }}
        </Button>
      </div>
    </DataState>

    <DataState
      v-if="!isCreate && canAssignPerm"
      :error="permissionError"
      :loading="loadingPermissions"
      @retry="loadPermissionDict"
    >
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
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
      <div class="mt-2 flex justify-end">
        <Button type="primary" @click="handleSavePermissions">
          {{ $t('proto.role.savePermissions') }}
        </Button>
      </div>
    </DataState>

    <p v-else-if="!isCreate" class="text-muted-foreground mt-4 text-sm">
      {{ $t('proto.role.noAssignPerm') }}
    </p>
  </Card>
</template>

<script setup lang="ts">
import type { MenuTreeNode, MenuType } from '@protohub/shared';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm, z } from '#/adapter/form';
import type { VbenFormSchema } from '#/adapter/form';

import { createMenuApi, updateMenuApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import { menuTreeToParentOptions } from '#/utils/menu-tree';

import type { MenuFormPayload } from '../types';

/**
 * 菜单新建/编辑抽屉（后端接口设计 §7.3.2 / §7.3.3 共用同一份 MenuFormParams）。
 * 字段按 type 显隐：目录/菜单/按钮/内嵌/外链只填自己有意义的项，避免同屏一堆空字段。
 * 上级候选由父级传入的菜单树推导，编辑时排除自身子树（否则会把节点挂到自己下面成环）。
 */
defineOptions({ name: 'MenuFormDrawer' });

const emit = defineEmits<{ reload: [] }>();

interface MenuFormValues {
  affixTab: boolean;
  authCode?: string;
  component?: string;
  hideInMenu: boolean;
  icon?: string;
  iframeSrc?: string;
  keepAlive: boolean;
  linkUrl?: string;
  name: string;
  path?: string;
  pid?: string;
  sort?: number;
  status?: 0 | 1;
  title: string;
  type: MenuType;
}

const menuId = ref<null | string>(null);
const tree = ref<MenuTreeNode[]>([]);

const isEdit = computed(() => menuId.value !== null);

const pageOptionValues = ['hideInMenu', 'keepAlive', 'affixTab'] as const;
type PageOptionKey = (typeof pageOptionValues)[number];

function buildSchema(nodes: MenuTreeNode[], excludeId?: string): VbenFormSchema[] {
  return [
    {
      component: 'RadioGroup',
      componentProps: {
        options: (['catalog', 'menu', 'button', 'embedded', 'link'] as MenuType[]).map(
          (type) => ({ label: $t(`proto.menu.types.${type}`), value: type }),
        ),
      },
      defaultValue: 'menu',
      fieldName: 'type',
      label: $t('proto.menu.fields.type'),
      rules: 'required',
    },
    {
      component: 'TreeSelect',
      componentProps: {
        fieldNames: { children: 'children', label: 'label', value: 'value' },
        treeData: [
          { label: $t('proto.menu.rootOption'), value: '' },
          ...menuTreeToParentOptions(nodes, excludeId),
        ],
        treeDefaultExpandAll: true,
      },
      fieldName: 'pid',
      label: $t('proto.menu.fields.pid'),
    },
    {
      component: 'Input',
      fieldName: 'title',
      label: $t('proto.menu.fields.title'),
      rules: z.string().min(1, { message: $t('proto.menu.fields.title') }),
    },
    {
      component: 'Input',
      dependencies: {
        show: (values) => values.type !== 'button',
        triggerFields: ['type'],
      },
      fieldName: 'name',
      label: $t('proto.menu.fields.name'),
      rules: z.string().min(1, { message: $t('proto.menu.fields.name') }),
    },
    {
      component: 'Input',
      dependencies: {
        show: (values) =>
          values.type === 'catalog' ||
          values.type === 'link' ||
          values.type === 'menu',
        triggerFields: ['type'],
      },
      fieldName: 'path',
      label: $t('proto.menu.fields.path'),
    },
    {
      component: 'Input',
      componentProps: { placeholder: $t('proto.menu.componentTip') },
      dependencies: {
        show: (values) => values.type === 'menu',
        triggerFields: ['type'],
      },
      fieldName: 'component',
      label: $t('proto.menu.fields.component'),
    },
    {
      component: 'Input',
      dependencies: {
        show: (values) => values.type === 'embedded',
        triggerFields: ['type'],
      },
      fieldName: 'iframeSrc',
      label: $t('proto.menu.fields.iframeSrc'),
      rules: z.string().url({ message: $t('proto.menu.urlRule') }).optional(),
    },
    {
      component: 'Input',
      dependencies: {
        show: (values) => values.type === 'link',
        triggerFields: ['type'],
      },
      fieldName: 'linkUrl',
      label: $t('proto.menu.fields.linkUrl'),
      rules: z.string().url({ message: $t('proto.menu.urlRule') }).optional(),
    },
    {
      component: 'Input',
      dependencies: {
        show: (values) => values.type === 'button',
        triggerFields: ['type'],
      },
      fieldName: 'authCode',
      label: $t('proto.menu.fields.authCode'),
    },
    {
      component: 'IconPicker',
      dependencies: {
        show: (values) => values.type !== 'button',
        triggerFields: ['type'],
      },
      fieldName: 'icon',
      label: $t('proto.menu.fields.icon'),
    },
    {
      component: 'CheckboxGroup',
      componentProps: {
        options: pageOptionValues.map((key) => ({
          label: $t(`proto.menu.fields.${key}`),
          value: key,
        })),
      },
      dependencies: {
        show: (values) => values.type === 'menu',
        triggerFields: ['type'],
      },
      fieldName: 'pageOptions',
      label: $t('proto.menu.fields.pageOptions'),
    },
    {
      component: 'InputNumber',
      componentProps: { max: 9999, min: 0 },
      fieldName: 'sort',
      label: $t('proto.common.sort'),
    },
    {
      component: 'RadioGroup',
      componentProps: {
        options: [
          { label: $t('proto.common.enabled'), value: 1 },
          { label: $t('proto.common.disabled'), value: 0 },
        ],
      },
      defaultValue: 1,
      fieldName: 'status',
      label: $t('proto.common.status'),
    },
  ];
}

const [Form, formApi] = useVbenForm({
  commonConfig: { labelWidth: 100 },
  schema: buildSchema([]),
  showDefaultActions: false,
  wrapperClass: 'grid-cols-1',
});

/** 抽屉每次打开都要用最新菜单树重建候选（新建后树变了，父级选项也必须跟着变） */
async function applySchema() {
  await formApi.setState({
    schema: buildSchema(tree.value, menuId.value ?? undefined),
  });
}

const [Drawer, drawerApi] = useVbenDrawer({
  confirmText: $t('proto.common.save'),
  async onConfirm() {
    await handleSubmit();
  },
  async onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const payload = drawerApi.getData<MenuFormPayload>();
    menuId.value = payload?.id ?? null;
    tree.value = payload?.tree ?? [];
    drawerApi.setState({
      title: isEdit.value
        ? $t('proto.menu.editTitle')
        : $t('proto.menu.createTitle'),
    });
    await applySchema();
    await formApi.resetForm();
    if (payload?.id) {
      await fillFromTree(payload.id);
    } else {
      await formApi.setValues({
        pageOptions: [],
        pid: payload?.pid ?? '',
        type: payload?.presetType ?? 'menu',
      });
    }
  },
});

/** §7.3 没有单条详情接口：树里的那一行就是全部字段 */
async function fillFromTree(id: string) {
  const row = findInTree(tree.value, id);
  if (!row) {
    return;
  }
  const pageOptions = pageOptionValues.filter((key) => row[key]);
  await formApi.setValues({
    authCode: row.authCode ?? '',
    component: row.component ?? '',
    icon: row.icon ?? '',
    iframeSrc: row.iframeSrc ?? '',
    linkUrl: row.linkUrl ?? '',
    name: row.name,
    pageOptions,
    path: row.path ?? '',
    pid: row.pid ?? '',
    sort: row.sort,
    status: row.status,
    title: row.title,
    type: row.type,
  });
}

function findInTree(nodes: MenuTreeNode[], id: string): null | MenuTreeNode {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    const hit = findInTree(node.children ?? [], id);
    if (hit) {
      return hit;
    }
  }
  return null;
}

async function handleSubmit() {
  const { valid } = await formApi.validate();
  if (!valid) {
    return;
  }
  const values = await formApi.getValues<
    MenuFormValues & { pageOptions?: PageOptionKey[] }
  >();
  const pageOptions = new Set(values.pageOptions ?? []);
  drawerApi.setState({ loading: true, submitting: true });
  try {
    const payload = {
      affixTab: pageOptions.has('affixTab'),
      authCode: values.authCode || undefined,
      component: values.component || undefined,
      hideInMenu: pageOptions.has('hideInMenu'),
      icon: values.icon || undefined,
      iframeSrc: values.iframeSrc || undefined,
      keepAlive: pageOptions.has('keepAlive'),
      linkUrl: values.linkUrl || undefined,
      name: values.name,
      path: values.path || undefined,
      pid: values.pid || undefined,
      sort: values.sort,
      status: values.status,
      title: values.title,
      type: values.type,
    };
    if (menuId.value) {
      await updateMenuApi(menuId.value, payload);
    } else {
      await createMenuApi(payload);
    }
    message.success($t('proto.common.success'));
    emit('reload');
    drawerApi.close();
  } catch (error) {
    message.error(
      toErrorMessage(error) || $t('proto.common.loadFailed'),
    );
  } finally {
    drawerApi.setState({ loading: false, submitting: false });
  }
}
</script>

<template>
  <Drawer>
    <Form />
  </Drawer>
</template>

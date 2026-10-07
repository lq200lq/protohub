<script setup lang="ts">
import type { ProjectListItem, ProjectStatus } from '@protohub/shared';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';

import {
  Alert,
  Button,
  Dropdown,
  Empty,
  Menu,
  MenuItem,
  Modal,
  Tag,
  message,
} from 'ant-design-vue';
import { useRouter } from 'vue-router';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import {
  archiveProjectApi,
  deleteProjectApi,
  getProjectsApi,
  unarchiveProjectApi,
} from '#/api';
import PublishDrawer from '#/components/proto/PublishDrawer.vue';
import ProtoStatusTag from '#/components/proto/ProtoStatusTag.vue';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

import ProjectFormDrawer from './components/ProjectFormDrawer.vue';

/**
 * 项目列表页（迭代实施计划 M2-T6，前端设计 §3.2）。
 * 列集合按 M2 交付口径：名称/编码/说明/原型数(含已发布)/近7天访问/创建人/最近更新/状态；
 * 项目行没有访问地址——一个项目多条链接，地址在原型列表里（§4.1 注）。
 */
defineOptions({ name: 'ProtoProjectList' });

/** vxe 代理回调参数：分页 + 远端排序（sortBy/sortOrder 透传给 §4.1.1） */
interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
  sort?: { field: string; order: 'asc' | 'desc' | null | undefined }[];
}
interface ProjectFilterFormValues {
  keyword?: string;
  status?: ProjectStatus;
}
interface RowMenuItem {
  danger?: boolean;
  key: string;
  label: string;
}

const router = useRouter();
const { hasAccessByCodes } = useAccess();

const loadError = ref<null | string>(null);

const canCreate = computed(() => hasAccessByCodes(['proto:project:create']));
/** §3.2 的主行动按钮要的是"上传 HTML 原型"（一并创建项目与原型），权限码在原型的 create 上 */
const canUpload = computed(() =>
  hasAccessByCodes(['proto:prototype:create']),
);
const canRead = computed(() => hasAccessByCodes(['proto:project:read']));
const canUpdate = computed(() => hasAccessByCodes(['proto:project:update']));
const canDelete = computed(() => hasAccessByCodes(['proto:project:delete']));
const canArchive = computed(() =>
  hasAccessByCodes(['proto:project:archive']),
);

const [FormDrawer, formDrawerApi] = useVbenDrawer({
  connectedComponent: ProjectFormDrawer,
});

/** §3.4 抽屉的 create 模式：项目与原型都新建，一次动作把空列表变成第一条可访问链接 */
const [PublishDrawerComp, publishDrawerApi] = useVbenDrawer({
  connectedComponent: PublishDrawer,
});

/** 只在"真的一个项目都没有"时替换成空状态；带筛选条件的 0 行是查询结果，不是没有项目 */
const noProjects = ref(false);

const [Grid, gridApi] = useVbenVxeGrid<ProjectListItem>({
  formOptions: {
    schema: [
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.project.filterKeyword'),
        },
        fieldName: 'keyword',
        label: $t('proto.project.columns.name'),
      },
      {
        component: 'Select',
        componentProps: {
          allowClear: true,
          options: [
            { label: $t('proto.common.statuses.draft'), value: 'draft' },
            { label: $t('proto.common.statuses.published'), value: 'published' },
            { label: $t('proto.common.statuses.archived'), value: 'archived' },
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
        field: 'name',
        minWidth: 160,
        slots: { default: 'name' },
        title: $t('proto.project.columns.name'),
      },
      {
        field: 'code',
        slots: { default: 'code' },
        title: $t('proto.project.columns.code'),
        width: 140,
      },
      {
        field: 'prototypeCount',
        minWidth: 140,
        slots: { default: 'prototypeCount' },
        sortable: true,
        title: $t('proto.project.columns.prototypeCount'),
      },
      {
        field: 'visitsLast7d',
        minWidth: 110,
        sortable: true,
        title: $t('proto.project.columns.visitsLast7d'),
      },
      {
        // §3.2：语义是"该项目下任一原型的最近发布时间"，没发布过才取项目更新时间；服务端按 lastPublishedAt 排序
        field: 'lastPublishedAt',
        minWidth: 140,
        slots: { default: 'recent' },
        sortable: true,
        title: $t('proto.project.columns.updatedAt'),
      },
      {
        field: 'status',
        slots: { default: 'status' },
        title: $t('proto.common.status'),
        width: 100,
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
          { page, sort }: ProxyQueryArgs,
          formValues: null | ProjectFilterFormValues | undefined,
        ) => {
          try {
            const firstSort = sort?.[0];
            const result = await getProjectsApi({
              keyword: formValues?.keyword || undefined,
              page: page.currentPage,
              pageSize: page.pageSize,
              sortBy: firstSort?.field,
              sortOrder: firstSort?.order ?? undefined,
              status: formValues?.status,
            });
            loadError.value = null;
            noProjects.value =
              result.total === 0 &&
              !formValues?.keyword &&
              !formValues?.status;
            return result;
          } catch (error) {
            // §10.2：失败保留表格 + 可重试横幅（服务端可读文案，如"缺少权限：…"）
            loadError.value =
              toErrorMessage(error) || $t('proto.common.loadFailed');
            throw error;
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    sortConfig: { remote: true },
    toolbarConfig: { custom: true },
  },
});

/** §3.2「最近更新」列：有发布过用 lastPublishedAt，否则退回项目更新时间；单元格分两行显示。 */
function recentParts(row: ProjectListItem): { date: string; time: string } {
  const text = formatDateTime(row.lastPublishedAt ?? row.updatedAt);
  const [date = '', time = ''] = text.split(' ');
  return { date, time };
}

function onDetail(row: ProjectListItem) {  // 路由路径与 seed 菜单一致（/proto/project/detail?id=，前端设计 §3.3）
  router.push({ path: '/proto/project/detail', query: { id: row.id } });
}

function onCreate() {
  formDrawerApi.setData({});
  formDrawerApi.open();
}

function onUpload() {
  publishDrawerApi.setData({ mode: 'create' });
  publishDrawerApi.open();
}

function onEdit(row: ProjectListItem) {
  formDrawerApi.setData({ id: row.id });
  formDrawerApi.open();
}

function onArchive(row: ProjectListItem) {
  Modal.confirm({
    // §4.1.7 影响面必须写清："其下所有原型链接"，而不是只说项目
    content: $t('proto.project.archiveConfirm', [row.name]),
    onOk: async () => {
      await archiveProjectApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.archive'),
  });
}

function onUnarchive(row: ProjectListItem) {
  Modal.confirm({
    content: $t('proto.project.restoreConfirm', [row.name]),
    onOk: async () => {
      await unarchiveProjectApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.restore'),
  });
}

function onDelete(row: ProjectListItem) {
  Modal.confirm({
    // §4.1.6：软删项目会级联其下全部原型
    content: $t('proto.project.deleteConfirm', [row.name]),
    okType: 'danger',
    onOk: async () => {
      await deleteProjectApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
    },
    title: $t('proto.common.delete'),
  });
}

/** 行操作收进一个「⋯」下拉（前端设计 §10.3），按权限码过滤 */
function rowMenus(row: ProjectListItem): RowMenuItem[] {
  const items: (RowMenuItem | false | null)[] = [
    canRead.value && { key: 'detail', label: $t('proto.common.detail') },
    canUpdate.value && { key: 'edit', label: $t('proto.common.edit') },
    canArchive.value &&
      (row.status === 'archived'
        ? { key: 'unarchive', label: $t('proto.common.restore') }
        : { key: 'archive', label: $t('proto.common.archive') }),
    canDelete.value && {
      danger: true,
      key: 'delete',
      label: $t('proto.common.delete'),
    },
  ];
  return items.filter((item): item is RowMenuItem => Boolean(item));
}

function onMenuClick(row: ProjectListItem, info: { key: number | string }) {
  switch (info.key) {
    case 'archive': {
      onArchive(row);
      break;
    }
    case 'delete': {
      onDelete(row);
      break;
    }
    case 'detail': {
      onDetail(row);
      break;
    }
    case 'edit': {
      onEdit(row);
      break;
    }
    case 'unarchive': {
      onUnarchive(row);
      break;
    }
  }
}
</script>

<template>
  <Page
    :description="$t('proto.project.listIntro')"
    auto-content-height
    :title="$t('proto.project.listTitle')"
  >

    <div class="flex h-full flex-col gap-2">
      <Alert v-if="loadError" :message="loadError" banner type="error">
        <template #action>
          <Button size="small" @click="gridApi.query()">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>

      <!-- 空状态（§3.2）：无项目时不留白，主行动就是"上传第一个 HTML 原型"。用 v-show 不 v-if——
           Grid 得一直挂载，发布成功后 gridApi.query() 才有地方回填列表 -->
      <div
        v-show="noProjects"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
        data-testid="project-empty"
      >
        <Empty />
        <p class="text-sm text-muted-foreground">
          {{ $t('proto.project.emptyIntro') }}
        </p>
        <Button v-if="canUpload" type="primary" @click="onUpload">
          {{ $t('proto.project.uploadFirst') }}
        </Button>
      </div>

      <Grid v-show="!noProjects" class="min-h-0 flex-1">
        <template #toolbar-tools>
          <div class="flex items-center gap-2">
            <!-- §3.2 的主行动按钮是"上传 HTML 原型"（一并创建项目与原型），新建项目退为次级 -->
            <Button v-if="canUpload" type="primary" @click="onUpload">
              {{ $t('proto.publish.createTitle') }}
            </Button>
            <Button
              v-if="canCreate"
              :type="canUpload ? 'default' : 'primary'"
              @click="onCreate"
            >
              {{ $t('proto.project.createTitle') }}
            </Button>
          </div>
        </template>

        <!-- L3：一行里唯一的重元素；名称可点是下钻主入口（§3.2） -->
        <template #name="{ row }">
          <Button
            class="max-w-full px-0 font-semibold"
            type="link"
            @click="onDetail(row)"
          >
            <span class="truncate">{{ row.name }}</span>
          </Button>
        </template>

        <template #code="{ row }">
          <span class="font-mono text-[13px]">{{ row.code }}</span>
        </template>

        <template #prototypeCount="{ row }">
          <template v-if="row.prototypeCount > 0">
            <span>{{ row.prototypeCount }}</span>
            <span class="text-muted-foreground text-xs ml-1">
              ({{ $t('proto.project.columns.publishedCount') }}
              {{ row.publishedCount }})
            </span>
          </template>
          <Tag v-else>{{ $t('proto.project.noPrototypes') }}</Tag>
        </template>

        <!-- §3.2：两行（日期 + 时间） -->
        <template #recent="{ row }">
          <div class="leading-tight">
            <div>{{ recentParts(row).date }}</div>
            <div class="text-muted-foreground text-xs">{{ recentParts(row).time }}</div>
          </div>
        </template>

        <template #status="{ row }">
          <ProtoStatusTag :status="row.status" />
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
                >
                  {{ item.label }}
                </MenuItem>
              </Menu>
            </template>
          </Dropdown>
        </template>
      </Grid>

      <FormDrawer @reload="gridApi.query()" />
      <PublishDrawerComp @reload="gridApi.query()" />
    </div>
  </Page>
</template>

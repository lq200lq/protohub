<script setup lang="ts">
import type {
  ProjectDetail,
  ProjectEventItem,
  PrototypeListItem,
  PrototypeStatus,
} from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer, useVbenModal } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';

import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Menu,
  MenuItem,
  Modal,
  Space,
  message,
} from 'ant-design-vue';
import { useRoute, useRouter } from 'vue-router';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import {
  archiveProjectApi,
  archivePrototypeApi,
  deleteProjectApi,
  deletePrototypeApi,
  getProjectDetailApi,
  getProjectEventsApi,
  getPrototypesApi,
  unarchiveProjectApi,
  unarchivePrototypeApi,
} from '#/api';
import CopyText from '#/components/proto/CopyText.vue';
import DataState from '#/components/common/DataState.vue';
import ExpandableText from '#/components/common/ExpandableText.vue';
import ProtoAccessModeTag from '#/components/proto/ProtoAccessModeTag.vue';
import ProtoStatusTag from '#/components/proto/ProtoStatusTag.vue';
import ReleaseEventTimeline from '#/components/proto/ReleaseEventTimeline.vue';
import { $t } from '#/locales';
import {
  ACCESS_LOG_ROUTE_PATH,
  buildAccessLogJumpQuery,
  isVisitsMetricClickable,
} from '#/views/proto/accesslog/accesslog-view';
import { toErrorMessage } from '#/utils/error';

import ProjectFormDrawer from '../components/ProjectFormDrawer.vue';
import ProjectMembersModal from '../components/ProjectMembersModal.vue';
import PrototypeFormDrawer from '../components/PrototypeFormDrawer.vue';

/**
 * 项目详情（迭代实施计划 M2-T8，前端设计 §3.3）：
 * 基本信息 + 统计条 + 原型列表（访问地址可复制、策略 Tag、状态）+ 成员管理（§4.1.9/§4.1.10）。
 * 文本态优先展示，编辑走抽屉（与系统页一致）；字段只放"新建可填 + 系统生成"。
 */
defineOptions({ name: 'ProtoProjectDetail' });

interface ProxyQueryArgs {
  page: { currentPage: number; pageSize: number };
}
interface PrototypeFilterFormValues {
  keyword?: string;
  status?: PrototypeStatus;
}
interface RowMenuItem {
  danger?: boolean;
  key: string;
  label: string;
}

const route = useRoute();
const router = useRouter();
const { hasAccessByCodes } = useAccess();

const projectId = computed(() => String(route.query.id ?? ''));

const detail = ref<null | ProjectDetail>(null);
const detailLoading = ref(false);
const detailError = ref<null | string>(null);
const gridError = ref<null | string>(null);
/** §10.2「空数据」：整个项目一个原型都没有（不是被筛选筛没的） */
const noPrototypes = ref(false);

const canUpdate = computed(() => hasAccessByCodes(['proto:project:update']));
const canDelete = computed(() => hasAccessByCodes(['proto:project:delete']));
const canArchive = computed(() =>
  hasAccessByCodes(['proto:project:archive']),
);
const canPrototypeCreate = computed(() =>
  hasAccessByCodes(['proto:prototype:create']),
);
const canPrototypeUpdate = computed(() =>
  hasAccessByCodes(['proto:prototype:update']),
);
const canPrototypeDelete = computed(() =>
  hasAccessByCodes(['proto:prototype:delete']),
);
const canPrototypeArchive = computed(() =>
  hasAccessByCodes(['proto:prototype:archive']),
);

const [ProjectDrawer, projectDrawerApi] = useVbenDrawer({
  connectedComponent: ProjectFormDrawer,
});
const [PrototypeDrawer, prototypeDrawerApi] = useVbenDrawer({
  connectedComponent: PrototypeFormDrawer,
});
const [MembersModal, membersModalApi] = useVbenModal({
  connectedComponent: ProjectMembersModal,
});

async function loadDetail() {
  if (!projectId.value) {
    detail.value = null;
    detailError.value = $t('proto.project.detailNotFound');
    return;
  }
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await getProjectDetailApi(projectId.value);
  } catch (error) {
    // 403"项目不存在或你没有访问权限"这类服务端可读文案原样呈现。
    // §10.2「请求失败」要求不清空上一份数据：刷新失败时页面继续显示上次那份，
    // 顶上一条失败横幅 + 重试，而不是把人正在看的内容抹成空白。
    detailError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    detailLoading.value = false;
  }
}

/** §3.3 项目动态：该项目下所有原型的版本事件（每条带原型名），与工作台「最近动态」共用呈现件 */
const ACTIVITY_LIMIT = 50;

const activityItems = ref<ProjectEventItem[]>([]);
const activityLoading = ref(false);
const activityError = ref<null | string>(null);

async function loadActivity() {
  if (!projectId.value) {
    activityItems.value = [];
    return;
  }
  activityLoading.value = true;
  activityError.value = null;
  try {
    const page = await getProjectEventsApi(projectId.value, {
      page: 1,
      pageSize: ACTIVITY_LIMIT,
    });
    activityItems.value = page.items;
  } catch (error) {
    activityError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    activityLoading.value = false;
  }
}

/** 详情与项目动态是同一屏的两块数据：改完项目/原型后一起刷 */
async function reloadAll() {
  await Promise.all([loadDetail(), loadActivity()]);
}

const [Grid, gridApi] = useVbenVxeGrid<PrototypeListItem>({
  formOptions: {
    schema: [
      {
        component: 'Input',
        componentProps: {
          allowClear: true,
          placeholder: $t('proto.prototype.filterKeyword'),
        },
        fieldName: 'keyword',
        label: $t('proto.prototype.columns.name'),
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
        minWidth: 140,
        slots: { default: 'prototypeName' },
        title: $t('proto.prototype.columns.name'),
      },
      {
        field: 'code',
        minWidth: 130,
        slots: { default: 'prototypeCode' },
        title: $t('proto.prototype.columns.code'),
      },
      {
        field: 'accessUrl',
        minWidth: 240,
        slots: { default: 'accessUrl' },
        title: $t('proto.prototype.columns.accessUrl'),
      },
      {
        field: 'currentRelease',
        minWidth: 100,
        slots: { default: 'currentVersion' },
        title: $t('proto.prototype.columns.currentVersion'),
      },
      {
        field: 'accessMode',
        minWidth: 110,
        slots: { default: 'policy' },
        title: $t('proto.prototype.columns.policy'),
      },
      {
        field: 'status',
        slots: { default: 'prototypeStatus' },
        title: $t('proto.common.status'),
        width: 100,
      },
      {
        field: 'updatedAt',
        formatter: ({ cellValue }: { cellValue: string }) =>
          formatDateTime(cellValue),
        minWidth: 150,
        title: $t('proto.prototype.columns.updatedAt'),
      },
      {
        field: 'action',
        fixed: 'right',
        slots: { default: 'prototypeAction' },
        title: $t('proto.common.action'),
        width: 80,
      },
    ],
    height: 'auto',
    proxyConfig: {
      ajax: {
        query: async (
          { page }: ProxyQueryArgs,
          formValues: null | PrototypeFilterFormValues | undefined,
        ) => {
          if (!projectId.value) {
            return { items: [], total: 0 };
          }
          try {
            // §4.3.1：原型列表必须带 projectId
            const result = await getPrototypesApi({
              keyword: formValues?.keyword || undefined,
              page: page.currentPage,
              pageSize: page.pageSize,
              projectId: projectId.value,
              status: formValues?.status,
            });
            gridError.value = null;
            // §10.2「空数据」：一个原型都没有（不是被筛选筛没的）才走引导态
            noPrototypes.value =
              result.items.length === 0 &&
              !formValues?.keyword &&
              !formValues?.status;
            return result;
          } catch (error) {
            // 与用户管理页同款失败态：保留可读服务端文案（如 403"缺少权限：…"）+ 重试
            gridError.value =
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

function onEditProject() {
  projectDrawerApi.setData({ id: projectId.value });
  projectDrawerApi.open();
}

function onCreatePrototype() {
  prototypeDrawerApi.setData({ projectId: projectId.value });
  prototypeDrawerApi.open();
}

function onEditPrototype(row: PrototypeListItem) {
  prototypeDrawerApi.setData({ id: row.id, projectId: projectId.value });
  prototypeDrawerApi.open();
}

function onPrototypeDetail(row: PrototypeListItem) {
  router.push({ path: '/proto/prototype/detail', query: { id: row.id } });
}

/**
 * 统计条「近 7 天访问量」→ 访问记录页带 projectId（前端设计 §3.3 统计条 + §3.7 两级下钻入口）。
 * 只带项目级范围；具体原型的下钻在访问记录页用它的两级筛选继续。
 */
function onVisitsJump() {
  router.push({
    path: ACCESS_LOG_ROUTE_PATH,
    query: buildAccessLogJumpQuery({ projectId: projectId.value }),
  });
}

function onArchiveProject() {
  const project = detail.value;
  if (!project) {
    return;
  }
  Modal.confirm({
    // §4.1.7：归档项目影响"其下所有原型链接"
    content: $t('proto.project.archiveConfirm', [project.name]),
    onOk: async () => {
      await archiveProjectApi(project.id);
      message.success($t('proto.common.success'));
      await reloadAll();
      gridApi.query();
    },
    title: $t('proto.common.archive'),
  });
}

function onUnarchiveProject() {
  const project = detail.value;
  if (!project) {
    return;
  }
  Modal.confirm({
    content: $t('proto.project.restoreConfirm', [project.name]),
    onOk: async () => {
      await unarchiveProjectApi(project.id);
      message.success($t('proto.common.success'));
      await reloadAll();
      gridApi.query();
    },
    title: $t('proto.common.restore'),
  });
}

function onDeleteProject() {
  const project = detail.value;
  if (!project) {
    return;
  }
  Modal.confirm({
    content: $t('proto.project.deleteConfirm', [project.name]),
    okType: 'danger',
    onOk: async () => {
      await deleteProjectApi(project.id);
      message.success($t('proto.common.success'));
      router.push({ path: '/proto/project' });
    },
    title: $t('proto.common.delete'),
  });
}

function onArchivePrototype(row: PrototypeListItem) {
  Modal.confirm({
    // §4.3.7：影响面写清"仅该原型的链接不可访问"（与项目归档的"其下所有原型"区分）
    content: $t('proto.prototype.archiveConfirm', [row.name]),
    onOk: async () => {
      await archivePrototypeApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
      reloadAll();
    },
    title: $t('proto.common.archive'),
  });
}

function onUnarchivePrototype(row: PrototypeListItem) {
  Modal.confirm({
    content: $t('proto.prototype.restoreConfirm', [row.name]),
    onOk: async () => {
      await unarchivePrototypeApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
      reloadAll();
    },
    title: $t('proto.common.restore'),
  });
}

function onDeletePrototype(row: PrototypeListItem) {
  Modal.confirm({
    content: $t('proto.prototype.deleteConfirm', [row.name]),
    okType: 'danger',
    onOk: async () => {
      await deletePrototypeApi(row.id);
      message.success($t('proto.common.success'));
      gridApi.query();
      reloadAll();
    },
    title: $t('proto.common.delete'),
  });
}

function prototypeMenus(row: PrototypeListItem): RowMenuItem[] {
  const items: (RowMenuItem | false | null)[] = [
    { key: 'detail', label: $t('proto.common.detail') },
    canPrototypeUpdate.value && {
      key: 'edit',
      label: $t('proto.common.edit'),
    },
    canPrototypeArchive.value &&
      (row.status === 'archived'
        ? { key: 'unarchive', label: $t('proto.common.restore') }
        : { key: 'archive', label: $t('proto.common.archive') }),
    canPrototypeDelete.value && {
      danger: true,
      key: 'delete',
      label: $t('proto.common.delete'),
    },
  ];
  return items.filter((item): item is RowMenuItem => Boolean(item));
}

function onPrototypeMenuClick(row: PrototypeListItem, info: { key: number | string }) {
  switch (info.key) {
    case 'archive': {
      onArchivePrototype(row);
      break;
    }
    case 'delete': {
      onDeletePrototype(row);
      break;
    }
    case 'detail': {
      onPrototypeDetail(row);
      break;
    }
    case 'edit': {
      onEditPrototype(row);
      break;
    }
    case 'unarchive': {
      onUnarchivePrototype(row);
      break;
    }
  }
}

function onMembers() {
  membersModalApi.setData({ projectId: projectId.value });
  membersModalApi.open();
}

watch(projectId, () => {
  reloadAll();
  gridApi.query();
});

reloadAll();
</script>

<template>
  <Page auto-content-height>
    <div class="flex h-full flex-col gap-3">
      <!-- 头部：项目名 + 派生状态 + 操作（§3.3） -->
      <Card :bordered="false" size="small">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Space :size="10" align="center" wrap>
            <Button size="small" @click="router.push({ path: '/proto/project' })">
              ←
            </Button>
            <span class="text-lg font-semibold">
              {{ detail?.name ?? '—' }}
            </span>
            <ProtoStatusTag v-if="detail" :status="detail.status" />
            <span class="text-muted-foreground font-mono text-[13px]">
              {{ detail?.code ?? '' }}
            </span>
          </Space>
          <Space v-if="detail" :size="8">
            <Button v-if="canPrototypeCreate" type="primary" @click="onCreatePrototype">
              {{ $t('proto.prototype.createTitle') }}
            </Button>
            <Button v-if="canUpdate" @click="onEditProject">
              {{ $t('proto.common.edit') }}
            </Button>
            <Button v-if="canArchive && detail.status !== 'archived'" @click="onArchiveProject">
              {{ $t('proto.common.archive') }}
            </Button>
            <Button v-else-if="canArchive" @click="onUnarchiveProject">
              {{ $t('proto.common.restore') }}
            </Button>
            <Dropdown v-if="canDelete" :trigger="['click']">
              <Button type="text">⋯</Button>
              <template #overlay>
                <Menu>
                  <MenuItem danger @click="onDeleteProject">
                    {{ $t('proto.common.delete') }}
                  </MenuItem>
                </Menu>
              </template>
            </Dropdown>
          </Space>
        </div>
      </Card>

      <!-- 三态收敛到 DataState（M1 既有组件）：加载 / 失败（服务端可读文案 + 重试）/ 内容。
           已经有一份数据时失败不再走 DataState 的失败态（那会把内容挡住），而是内容照旧 +
           上面这条横幅——§10.2「请求失败」：不清空上一份数据 -->
      <Alert v-if="detail && detailError" :message="detailError" banner type="error">
        <template #action>
          <Button size="small" @click="loadDetail()">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>
      <DataState
        :error="detail ? null : detailError"
        :loading="detailLoading"
        @retry="loadDetail"
      >
        <div v-if="detail" class="flex flex-col gap-3">
        <!-- 基本信息 + 统计条 -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.project.sections.basic')"
        >
          <div class="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.project.fields.description') }}
              </span>
              <ExpandableText :text="detail.description" />
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.project.basic.createdBy') }}
              </span>
              <p>{{ detail.createdByName }}</p>
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.project.basic.createdAt') }}
              </span>
              <p>{{ formatDateTime(detail.createdAt) }}</p>
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.project.basic.lastPublishedAt') }}
              </span>
              <p>{{ detail.lastPublishedAt ? formatDateTime(detail.lastPublishedAt) : '—' }}</p>
            </div>
            <div v-if="detail.archivedAt">
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.project.basic.archivedAt') }}
              </span>
              <p>{{ formatDateTime(detail.archivedAt) }}</p>
            </div>
          </div>
          <div
            class="mt-4 flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-border pt-4 text-sm"
          >
            <span>
              <span class="text-muted-foreground">{{ $t('proto.project.stats.prototypes') }}：</span>
              <span class="font-semibold">{{ detail.prototypeCount.total }}</span>
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.project.stats.published') }}：</span>
              <span class="font-semibold">{{ detail.prototypeCount.published }}</span>
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.project.stats.draft') }}：</span>
              <span class="font-semibold">{{ detail.prototypeCount.draft }}</span>
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.project.stats.visits7d') }}：</span>
              <!-- 可点的统计值：与原型详情同款 type=link 内联链接，数字是本体；缺值退回不可点纯数字 -->
              <Button
                v-if="isVisitsMetricClickable(detail.visitsLast7d)"
                class="font-semibold px-0"
                type="link"
                @click="onVisitsJump"
              >
                {{ detail.visitsLast7d }}
              </Button>
              <span v-else class="font-semibold">{{ detail.visitsLast7d }}</span>
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.project.stats.members') }}：</span>
              <span class="font-semibold">{{ detail.memberCount }}</span>
              <Button v-if="canUpdate" class="ml-2 px-0" type="link" @click="onMembers">
                {{ $t('proto.project.members.save') }}
              </Button>
            </span>
          </div>
        </Card>

        <!-- 原型列表（主体） -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.project.sections.prototypes')"
          class="min-h-0 flex-1"
        >
          <Alert v-if="gridError" :message="gridError" banner class="mb-2" type="error">
            <template #action>
              <Button size="small" @click="gridApi.query()">
                {{ $t('proto.common.retry') }}
              </Button>
            </template>
          </Alert>
          <!-- §10.2「空数据」：插画 + 一句引导 + 主行动按钮，不留白。v-show 不 v-if——
               Grid 得一直挂载，新建原型后 gridApi.query() 才有地方回填 -->
          <div
            v-show="noPrototypes"
            class="flex min-h-40 flex-col items-center justify-center gap-3"
            data-testid="prototype-empty"
          >
            <Empty />
            <p class="text-muted-foreground text-sm">
              {{ $t('proto.prototype.listEmpty') }}
            </p>
            <Button
              v-if="canPrototypeCreate"
              type="primary"
              @click="onCreatePrototype"
            >
              {{ $t('proto.prototype.createTitle') }}
            </Button>
          </div>
          <Grid v-show="!noPrototypes">
            <template #prototypeName="{ row }">
              <Button
                class="max-w-full px-0 font-semibold"
                type="link"
                @click="onPrototypeDetail(row)"
              >
                <span class="truncate">{{ row.name }}</span>
              </Button>
            </template>
            <template #prototypeCode="{ row }">
              <span class="font-mono text-[13px]">{{ row.code }}</span>
            </template>
            <!-- 访问地址来自服务端 accessUrl（§4.3 注：前端不拼域名） -->
            <template #accessUrl="{ row }">
              <CopyText :text="row.accessUrl" :max-width="220" />
            </template>
            <template #currentVersion="{ row }">
              <span v-if="row.currentRelease" class="font-mono text-[13px]">
                {{ $t('proto.prototype.version.no', [row.currentRelease.versionNo]) }}
              </span>
              <span v-else class="text-muted-foreground">—</span>
            </template>
            <template #policy="{ row }">
              <ProtoAccessModeTag :mode="row.accessMode" />
            </template>
            <template #prototypeStatus="{ row }">
              <ProtoStatusTag :status="row.status" />
            </template>
            <template #prototypeAction="{ row }">
              <Dropdown :trigger="['click']">
                <Button size="small" type="text">⋯</Button>
                <template #overlay>
                  <Menu @click="onPrototypeMenuClick(row, $event)">
                    <MenuItem
                      v-for="item in prototypeMenus(row)"
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
        </Card>

        <!-- 项目动态（§3.3）：该项目下所有原型的版本事件，每条带原型名；
             与工作台「最近动态」共用 ReleaseEventTimeline（前端设计 §6） -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.project.sections.activity')"
        >
          <ReleaseEventTimeline
            :error="activityError"
            :events="activityItems"
            :loading="activityLoading"
            @retry="loadActivity"
          />
        </Card>
        </div>
      </DataState>

      <ProjectDrawer @reload="reloadAll" />
      <PrototypeDrawer @reload="() => { gridApi.query(); reloadAll(); }" />
      <MembersModal />
    </div>
  </Page>
</template>

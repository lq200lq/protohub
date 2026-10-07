<script setup lang="ts">
import type {
  AccessMode,
  ProjectDetail,
  ProjectMemberItem,
  PrototypeDetail,
} from '@protohub/shared';

import { computed, ref, watch } from 'vue';

import { useAccess } from '@vben/access';
import { Page, useVbenDrawer } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';

import {
  Alert,
  Button,
  Card,
  Collapse,
  CollapsePanel,
  InputPassword,
  Modal,
  Radio,
  RadioGroup,
  Space,
  Tag,
  message,
} from 'ant-design-vue';
import { useRoute, useRouter } from 'vue-router';

import {
  archivePrototypeApi,
  deletePrototypeApi,
  getProjectDetailApi,
  getProjectMembersApi,
  getPrototypeDetailApi,
  unarchivePrototypeApi,
  updatePrototypePolicyApi,
} from '#/api';
import CopyText from '#/components/proto/CopyText.vue';
import DataState from '#/components/common/DataState.vue';
import ExpandableText from '#/components/common/ExpandableText.vue';
import PublishDrawer from '#/components/proto/PublishDrawer.vue';
import ProtoAccessModeTag from '#/components/proto/ProtoAccessModeTag.vue';
import ProtoStatusTag from '#/components/proto/ProtoStatusTag.vue';
import PrototypePicker from '#/components/proto/PrototypePicker.vue';
import ReleaseTimeline from '#/components/proto/ReleaseTimeline.vue';
import { $t } from '#/locales';
import {
  ACCESS_LOG_ROUTE_PATH,
  buildAccessLogJumpQuery,
  isVisitsMetricClickable,
} from '#/views/proto/accesslog/accesslog-view';
import PrototypeFormDrawer from '#/views/proto/project/components/PrototypeFormDrawer.vue';
import { toErrorMessage } from '#/utils/error';
import { formatBytes } from '#/utils/format';

import PrototypeAccessLogPanel from './PrototypeAccessLogPanel.vue';

/**
 * 原型详情（迭代实施计划 M2-T9，前端设计 §3.5）：分享链接与策略的落点。
 * 版本记录 / 发布报告属 M3；访问记录折叠区在 M4-T12 接上真实数据（展开才取、最近 20 条），
 * 近 7 天访问量点进访问记录页带 prototypeId 筛选。
 */
defineOptions({ name: 'ProtoPrototypeDetail' });

const route = useRoute();
const router = useRouter();
const { hasAccessByCodes } = useAccess();

const prototypeId = computed(() => String(route.query.id ?? ''));

const detail = ref<null | PrototypeDetail>(null);
const project = ref<null | ProjectDetail>(null);
const members = ref<ProjectMemberItem[]>([]);
const detailLoading = ref(false);
const detailError = ref<null | string>(null);
const membersError = ref<null | string>(null);

const canUpdate = computed(() =>
  hasAccessByCodes(['proto:prototype:update']),
);
const canDelete = computed(() =>
  hasAccessByCodes(['proto:prototype:delete']),
);
const canArchive = computed(() =>
  hasAccessByCodes(['proto:prototype:archive']),
);
const canPolicy = computed(() =>
  hasAccessByCodes(['proto:prototype:policy']),
);
const canPublish = computed(() =>
  hasAccessByCodes(['proto:prototype:publish']),
);
/** §10.2「无权限」：页面内区块**整块隐藏**，不是在里面塞一句"无权限"占位 */
const canViewAccessLog = computed(() =>
  hasAccessByCodes(['proto:accesslog:list']),
);

const [FormDrawer, formDrawerApi] = useVbenDrawer({
  connectedComponent: PrototypeFormDrawer,
});

const [PublishDrawerComp, publishDrawerApi] = useVbenDrawer({
  connectedComponent: PublishDrawer,
});

/** 时间线自己管两条数据源（§5.4 版本行 + §5.8 事件），发布/回滚后由这里叫它重取。 */
const timelineRef = ref<InstanceType<typeof ReleaseTimeline> | null>(null);

function reloadAll() {
  void loadAll();
  timelineRef.value?.reload();
}

/** §3.5 头部「上传新版本」= §3.4 抽屉的 append 模式：项目与原型都带过去锁死 */
function onUploadNew() {
  const current = detail.value;
  if (!current) {
    return;
  }
  publishDrawerApi.setData({
    accessUrl: current.accessUrl,
    mode: 'append',
    projectCode: project.value?.code,
    projectId: current.projectId,
    projectName: project.value?.name,
    prototypeCode: current.code,
    prototypeId: current.id,
    prototypeName: current.name,
  });
  publishDrawerApi.open();
}

async function loadAll() {
  if (!prototypeId.value) {
    detail.value = null;
    detailError.value = $t('proto.prototype.detailNotFound');
    return;
  }
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await getPrototypeDetailApi(prototypeId.value);
  } catch (error) {
    // 403"项目不存在或你没有访问权限"这类服务端可读文案原样呈现。
    // §10.2「请求失败」：不清空上一份数据，刷新失败时继续显示上次那份 + 失败横幅。
    detailError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
    return;
  } finally {
    detailLoading.value = false;
  }
  resetPolicyEditor();
  // 所属项目与成员是只读派生信息（§4.4：member 档可访问人 = 父项目成员），失败不阻塞本页
  const projectId = detail.value.projectId;
  getProjectDetailApi(projectId)
    .then((result) => {
      project.value = result;
    })
    .catch(() => {
      project.value = null;
    });
  membersError.value = null;
  try {
    members.value = await getProjectMembersApi(projectId);
  } catch (error) {
    members.value = [];
    membersError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  }
}

/* ---------- 访问策略编辑（§4.4：只发 accessMode/password，不发 memberIds） ---------- */

const policyEditing = ref(false);
const policyMode = ref<AccessMode>('public');
const policyPassword = ref('');
const policySaving = ref(false);
const policyError = ref<null | string>(null);

function resetPolicyEditor() {
  policyEditing.value = false;
  policyMode.value = detail.value?.accessMode ?? 'public';
  policyPassword.value = '';
  policyError.value = null;
}

function startPolicyEdit() {
  policyMode.value = detail.value?.accessMode ?? 'public';
  policyPassword.value = '';
  policyError.value = null;
  policyEditing.value = true;
}

async function savePolicy() {
  const current = detail.value;
  if (!current) {
    return;
  }
  const password = policyPassword.value.trim();
  if (policyMode.value === 'password' && password && password.length < 6) {
    policyError.value = $t('proto.prototype.policy.passwordRule');
    return;
  }
  if (
    policyMode.value === 'password' &&
    !password &&
    !current.hasAccessPassword
  ) {
    // 与后端 400 PROTO_POLICY_PASSWORD_REQUIRED 同语义，提前拦住少一次往返
    policyError.value = $t('proto.prototype.policy.passwordRule');
    return;
  }
  policySaving.value = true;
  policyError.value = null;
  try {
    detail.value = await updatePrototypePolicyApi(current.id, {
      accessMode: policyMode.value,
      // password 省略即沿用旧密码（§4.4）
      password: password || undefined,
    });
    message.success($t('proto.prototype.policy.updated'));
    resetPolicyEditor();
  } catch (error) {
    policyError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
  } finally {
    policySaving.value = false;
  }
}

/* ---------- 行操作（M2-T10） ---------- */

function onEdit() {
  const current = detail.value;
  if (!current) {
    return;
  }
  formDrawerApi.setData({ id: current.id, projectId: current.projectId });
  formDrawerApi.open();
}

function onArchive() {
  const current = detail.value;
  if (!current) {
    return;
  }
  Modal.confirm({
    // §4.3.7：影响面"仅该原型的链接不可访问"（与项目归档文案区分）
    content: $t('proto.prototype.archiveConfirm', [current.name]),
    onOk: async () => {
      detail.value = await archivePrototypeApi(current.id);
      message.success($t('proto.common.success'));
    },
    title: $t('proto.common.archive'),
  });
}

function onUnarchive() {
  const current = detail.value;
  if (!current) {
    return;
  }
  Modal.confirm({
    content: $t('proto.prototype.restoreConfirm', [current.name]),
    onOk: async () => {
      detail.value = await unarchivePrototypeApi(current.id);
      message.success($t('proto.common.success'));
    },
    title: $t('proto.common.restore'),
  });
}

function onDelete() {
  const current = detail.value;
  if (!current) {
    return;
  }
  Modal.confirm({
    content: $t('proto.prototype.deleteConfirm', [current.name]),
    okType: 'danger',
    onOk: async () => {
      await deletePrototypeApi(current.id);
      message.success($t('proto.common.success'));
      router.push({
        path: '/proto/project/detail',
        query: { id: current.projectId },
      });
    },
    title: $t('proto.common.delete'),
  });
}

function onPickPrototype(payload: { projectId: string; prototype: { id: string } }) {
  router.replace({
    path: '/proto/prototype/detail',
    query: { id: payload.prototype.id },
  });
}

/** 立即访问：地址是服务端拼好的 accessUrl，前端只做打开，不自行构造 */
function openAccessUrl() {
  const url = detail.value?.accessUrl;
  if (url) {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * 近 7 天访问量点进访问记录（前端设计 §3.5「访问信息…近 7 天访问量（点击跳访问记录并带
 * prototypeId 筛选）」）：只带 prototypeId，项目级范围由访问记录页自己按原型详情回填。
 */
function onVisitsJump() {
  const current = detail.value;
  if (current) {
    router.push({
      path: ACCESS_LOG_ROUTE_PATH,
      query: buildAccessLogJumpQuery({ prototypeId: current.id }),
    });
  }
}

/** 访问记录折叠区：展开那一帧才把 enabled 递给面板，避免进页面就打一次明细查询（M4-T12） */
const accessLogActive = ref<string[]>([]);
const accessLogEnabled = computed(() => accessLogActive.value.includes('accessLog'));

watch(prototypeId, () => {
  loadAll();
});

loadAll();
</script>

<template>
  <Page auto-content-height>
    <div class="flex flex-col gap-3">
      <!-- 三态收敛到 DataState（M1 既有组件）：加载 / 失败（服务端可读文案 + 重试）/ 内容 -->
      <Alert v-if="detail && detailError" :message="detailError" banner type="error">
        <template #action>
          <Button size="small" @click="loadAll()">
            {{ $t('proto.common.retry') }}
          </Button>
        </template>
      </Alert>
      <DataState
        :error="detail ? null : detailError"
        :loading="detailLoading"
        @retry="loadAll"
      >
        <div v-if="detail" class="flex flex-col gap-3">
        <!-- 头部：原型名 + 状态 + 策略 Tag + 操作（§3.5） -->
        <Card :bordered="false" size="small">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Space :size="10" align="center" wrap>
              <Button
                size="small"
                @click="router.push({ path: '/proto/project/detail', query: { id: detail.projectId } })"
              >
                ←
              </Button>
              <span class="text-lg font-semibold">{{ detail.name }}</span>
              <ProtoStatusTag :status="detail.status" />
              <ProtoAccessModeTag :mode="detail.accessMode" />
            </Space>
            <Space :size="8">
              <PrototypePicker @pick="onPickPrototype" />
              <Button v-if="canPublish" type="primary" @click="onUploadNew">
                {{ $t('proto.publish.appendTitle') }}
              </Button>
              <Button v-if="canUpdate" @click="onEdit">
                {{ $t('proto.common.edit') }}
              </Button>
              <Button v-if="canArchive && detail.status !== 'archived'" @click="onArchive">
                {{ $t('proto.common.archive') }}
              </Button>
              <Button v-else-if="canArchive" @click="onUnarchive">
                {{ $t('proto.common.restore') }}
              </Button>
              <Button v-if="canDelete" danger @click="onDelete">
                {{ $t('proto.common.delete') }}
              </Button>
            </Space>
          </div>
        </Card>

        <!-- 访问信息：地址来自服务端 accessUrl，前端不拼域名（§4.3 注） -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.prototype.sections.access')"
        >
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-muted-foreground w-28 text-sm shrink-0">
                {{ $t('proto.prototype.fieldsInfo.accessUrl') }}
              </span>
              <CopyText :text="detail.accessUrl" :max-width="480" />
              <Button
                v-if="detail.status === 'published'"
                size="small"
                @click="openAccessUrl"
              >
                {{ $t('proto.prototype.openLink') }}
              </Button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-muted-foreground w-28 text-sm shrink-0">
                {{ $t('proto.prototype.fieldsInfo.policy') }}
              </span>
              <template v-if="!policyEditing">
                <ProtoAccessModeTag :mode="detail.accessMode" />
                <Button v-if="canPolicy" size="small" @click="startPolicyEdit">
                  {{ $t('proto.prototype.policy.edit') }}
                </Button>
              </template>
              <div v-else class="flex flex-1 flex-col gap-2">
                <RadioGroup v-model:value="policyMode">
                  <Radio value="public">
                    {{ $t('proto.common.accessModes.public') }}
                  </Radio>
                  <Radio value="password">
                    {{ $t('proto.common.accessModes.password') }}
                  </Radio>
                  <Radio value="member">
                    {{ $t('proto.common.accessModes.member') }}
                  </Radio>
                </RadioGroup>
                <div
                  v-if="policyMode === 'password'"
                  class="flex flex-wrap items-center gap-2"
                >
                  <InputPassword
                    v-model:value="policyPassword"
                    :placeholder="
                      detail.hasAccessPassword
                        ? $t('proto.prototype.policy.passwordKeep')
                        : $t('proto.prototype.policy.passwordRule')
                    "
                    class="max-w-64"
                  />
                  <span class="text-muted-foreground text-xs">
                    {{ $t('proto.prototype.policy.passwordRule') }}
                    <template v-if="detail.hasAccessPassword">
                      · {{ $t('proto.prototype.policy.passwordKeep') }}
                    </template>
                  </span>
                </div>
                <p v-if="policyMode === 'member'" class="text-muted-foreground text-xs">
                  {{ $t('proto.prototype.policy.memberNote') }}
                </p>
                <p class="text-muted-foreground text-xs">
                  {{ $t('proto.prototype.policy.switchHint') }}
                </p>
                <Alert
                  v-if="policyError"
                  :message="policyError"
                  banner
                  type="error"
                />
                <Space :size="8">
                  <Button :loading="policySaving" type="primary" @click="savePolicy">
                    {{ $t('proto.common.save') }}
                  </Button>
                  <Button @click="resetPolicyEditor">
                    {{ $t('proto.common.cancel') }}
                  </Button>
                </Space>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-muted-foreground w-28 text-sm shrink-0">
                {{ $t('proto.prototype.fieldsInfo.visits7d') }}
              </span>
              <!-- 可点的统计值：沿用本页「所属项目」那种 type=link 内联链接的语义，数字仍是本体；
                   visitsLast7d 缺值时退回不可点的纯数字，不给一个跳到空筛选的死链 -->
              <Button
                v-if="isVisitsMetricClickable(detail.visitsLast7d)"
                class="font-semibold px-0"
                type="link"
                @click="onVisitsJump"
              >
                {{ detail.visitsLast7d }}
              </Button>
              <span v-else class="font-semibold">{{ detail.visitsLast7d }}</span>
            </div>
          </div>
        </Card>

        <!-- 基本信息：新建可填字段 + 系统生成信息（§3.5 字段范围约束，不放密码） -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.prototype.sections.basic')"
        >
          <div class="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.prototype.fields.code') }}
              </span>
              <p class="font-mono">{{ detail.code }}</p>
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.prototype.fields.description') }}
              </span>
              <ExpandableText :text="detail.description" />
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.prototype.fieldsInfo.project') }}
              </span>
              <p>
                <Button
                  v-if="project"
                  class="px-0"
                  type="link"
                  @click="router.push({ path: '/proto/project/detail', query: { id: detail.projectId } })"
                >
                  {{ project.name }}
                </Button>
                <span v-else>—</span>
              </p>
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.prototype.fieldsInfo.createdAt') }}
              </span>
              <p>{{ formatDateTime(detail.createdAt) }}</p>
            </div>
            <div>
              <span class="text-muted-foreground text-sm">
                {{ $t('proto.prototype.fieldsInfo.updatedAt') }}
              </span>
              <p>{{ formatDateTime(detail.updatedAt) }}</p>
            </div>
          </div>
        </Card>

        <!-- 当前版本：M2 只有摘要字段；未发布给空态 -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.prototype.sections.currentVersion')"
        >
          <div
            v-if="detail.currentRelease"
            class="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm"
          >
            <Tag color="green">
              {{ $t('proto.prototype.version.no', [detail.currentRelease.versionNo]) }}
            </Tag>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.prototype.version.fileCount') }}：</span>
              {{ detail.currentRelease.fileCount }}
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.prototype.version.totalBytes') }}：</span>
              {{ formatBytes(detail.currentRelease.totalBytes) }}
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.prototype.version.publishedBy') }}：</span>
              {{ detail.currentRelease.publishedByName }}
            </span>
            <span>
              <span class="text-muted-foreground">{{ $t('proto.prototype.version.publishedAt') }}：</span>
              {{ formatDateTime(detail.currentRelease.publishedAt) }}
            </span>
          </div>
          <p v-else class="text-muted-foreground py-4 text-center text-sm">
            {{ $t('proto.prototype.version.notPublished') }}
          </p>
        </Card>

        <!-- 可访问成员：只读，派生自父项目成员（detail.memberIds 无用户信息，用成员接口渲染） -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.prototype.sections.members')"
        >
          <Alert
            v-if="membersError"
            :message="membersError"
            banner
            class="mb-2"
            type="error"
          />
          <p
            v-else-if="members.length === 0"
            class="text-muted-foreground py-4 text-center text-sm"
          >
            {{ $t('proto.prototype.members.empty') }}
          </p>
          <div v-else>
            <div
              v-for="member in members"
              :key="member.userId"
              class="flex items-center justify-between border-b border-border py-2 last:border-b-0"
            >
              <div>
                <span class="font-semibold">{{ member.realName }}</span>
                <span class="text-muted-foreground ml-2 text-[13px]">
                  {{ member.username }}
                </span>
              </div>
              <Tag
                :color="member.memberRole === 'owner' ? 'gold' : 'default'"
              >
                {{
                  member.memberRole === 'owner'
                    ? $t('proto.common.memberRoles.owner')
                    : member.memberRole === 'editor'
                      ? $t('proto.common.memberRoles.editor')
                      : $t('proto.common.memberRoles.viewer')
                }}
              </Tag>
            </div>
            <p class="text-muted-foreground mt-2 text-xs">
              {{ $t('proto.prototype.policy.memberNote') }}
            </p>
          </div>
        </Card>

        <!-- 版本记录（§3.5 主体）：时间线含发布/回滚/删除、当前生效标记、逐版展开发布报告 -->
        <Card
          :bordered="false"
          size="small"
          :title="$t('proto.prototype.sections.versions')"
        >
          <ReleaseTimeline
            v-if="detail"
            ref="timelineRef"
            :prototype-id="detail.id"
            @rolled-back="loadAll"
          />
        </Card>

        <!-- 访问记录折叠区（前端设计 §3.5「该原型最近 20 条访问；更多跳访问记录页」，M4-T12）：
             真实数据，展开那一帧才取数；面板自带加载/空/失败三态，这里只负责递范围。 -->
        <Collapse
          v-if="canViewAccessLog"
          v-model:activeKey="accessLogActive"
          :multiple="true"
        >
          <CollapsePanel
            :header="$t('proto.prototype.sections.accessLog')"
            key="accessLog"
          >
            <PrototypeAccessLogPanel :enabled="accessLogEnabled" :prototype-id="detail.id" />
          </CollapsePanel>
        </Collapse>
        </div>
      </DataState>

      <FormDrawer @reload="loadAll" />
      <PublishDrawerComp @reload="reloadAll" />
    </div>
  </Page>
</template>

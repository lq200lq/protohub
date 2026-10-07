<script setup lang="ts">
import type { MemberRole, ProjectMemberItem, UserListItem } from '@protohub/shared';

import { ref } from 'vue';

import { useVbenModal } from '@vben/common-ui';
import { formatDateTime } from '@vben/utils';

import {
  Alert,
  Button,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from 'ant-design-vue';

import { getProjectMembersApi, getSystemUsersApi, setProjectMembersApi } from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';

/**
 * 项目成员管理（M2 交付，接口 §4.1.9/§4.1.10）：
 * PUT 是覆盖式——保存时整量提交所选用户；已有成员的 memberRole 原样带上
 * （一期只记录不鉴权，但不要把 owner 冲掉；后端也会保底不移除创建人 owner）。
 */
defineOptions({ name: 'ProjectMembersModal' });

const emit = defineEmits<{ reload: [] }>();

interface UserOption {
  label: string;
  value: string;
}

const projectId = ref<null | string>(null);
const editing = ref(false);
const loading = ref(false);
const saving = ref(false);
const loadError = ref<null | string>(null);
const members = ref<ProjectMemberItem[]>([]);
const selectedUserIds = ref<string[]>([]);
const userOptions = ref<UserOption[]>([]);
const usersError = ref<null | string>(null);

function roleColor(role: MemberRole): string {
  return role === 'owner' ? 'gold' : 'default';
}

async function loadMembers(id: string) {
  loading.value = true;
  loadError.value = null;
  try {
    members.value = await getProjectMembersApi(id);
  } catch (error) {
    loadError.value = toErrorMessage(error) || $t('proto.common.loadFailed');
    members.value = [];
  } finally {
    loading.value = false;
  }
}

async function loadUserOptions() {
  usersError.value = null;
  try {
    const result = await getSystemUsersApi({ page: 1, pageSize: 200 });
    userOptions.value = result.items.map((user: UserListItem) => ({
      label: `${user.realName}（${user.username}）`,
      value: user.id,
    }));
  } catch (error) {
    // 用户列表接口需要 system:user:list——没有该权限时降级为只读展示
    usersError.value =
      toErrorMessage(error) || $t('proto.project.members.usersLoadFailed');
  }
}

function startEdit() {
  selectedUserIds.value = members.value.map((member) => member.userId);
  editing.value = true;
  if (userOptions.value.length === 0) {
    loadUserOptions();
  }
}

const [Modal, modalApi] = useVbenModal({
  destroyOnClose: true,
  showConfirmButton: false,
  cancelText: $t('proto.common.cancel'),
  async onOpenChange(isOpen) {
    if (!isOpen) {
      return;
    }
    const data = modalApi.getData<{ projectId: string }>();
    projectId.value = data.projectId ?? null;
    editing.value = false;
    if (projectId.value) {
      await loadMembers(projectId.value);
    }
  },
});

async function onSave() {
  if (!projectId.value) {
    return;
  }
  saving.value = true;
  try {
    // 覆盖式：memberRole 沿用现值，新加入的走服务端默认（editor/viewer 一期不区分授权）
    const roleByUser = new Map(members.value.map((m) => [m.userId, m.memberRole]));
    await setProjectMembersApi(projectId.value, {
      members: selectedUserIds.value.map((userId) => {
        const role = roleByUser.get(userId);
        return role ? { memberRole: role, userId } : { userId };
      }),
    });
    message.success($t('proto.project.members.updated'));
    editing.value = false;
    await loadMembers(projectId.value);
    emit('reload');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal :title="$t('proto.project.sections.members')">
    <Alert
      v-if="loadError"
      :message="loadError"
      banner
      type="error"
      show-icon
      class="mb-3"
    >
      <template #action>
        <Button v-if="projectId" size="small" @click="loadMembers(projectId)">
          {{ $t('proto.common.retry') }}
        </Button>
      </template>
    </Alert>

    <div v-if="editing" class="flex flex-col gap-2">
      <Select
        v-model:value="selectedUserIds"
        :loading="usersError !== null"
        :options="userOptions"
        :placeholder="$t('proto.project.members.selectPlaceholder')"
        mode="multiple"
        option-filter-prop="label"
        show-search
      />
      <p v-if="usersError" class="text-destructive text-xs">{{ usersError }}</p>
      <p class="text-muted-foreground text-xs">
        {{ $t('proto.project.members.ownerTip') }}
      </p>
      <div class="mt-2 flex justify-end gap-2">
        <Button @click="editing = false">{{ $t('proto.common.cancel') }}</Button>
        <Button :loading="saving" type="primary" @click="onSave">
          {{ $t('proto.project.members.save') }}
        </Button>
      </div>
    </div>

    <div v-else>
      <div v-if="loading" class="flex justify-center py-8">
        <Spin />
      </div>
      <template v-else>
        <p
          v-if="members.length === 0 && !loadError"
          class="text-muted-foreground py-6 text-center"
        >
          {{ $t('proto.project.members.empty') }}
        </p>
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
          <Space :size="8">
            <Tag :color="roleColor(member.memberRole)">
              {{
                member.memberRole === 'owner'
                  ? $t('proto.common.memberRoles.owner')
                  : member.memberRole === 'editor'
                    ? $t('proto.common.memberRoles.editor')
                    : $t('proto.common.memberRoles.viewer')
              }}
            </Tag>
            <span class="text-muted-foreground text-xs">
              {{ formatDateTime(member.createdAt) }}
            </span>
          </Space>
        </div>
        <div class="mt-3 flex justify-end">
          <Button type="primary" @click="startEdit">{{ $t('proto.common.edit') }}</Button>
        </div>
      </template>
    </div>
  </Modal>
</template>

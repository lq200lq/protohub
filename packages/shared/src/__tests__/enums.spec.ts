import { describe, expect, it } from 'vitest';

import {
  ACCESS_LOG_RESULTS,
  ACCESS_MODES,
  ACCESS_REASONS,
  BUILT_IN_ROLE_CODES,
  DATA_SCOPES,
  MEMBER_ROLES,
  MENU_TYPES,
  PROTOTYPE_STATUSES,
  RELEASE_EVENT_TYPES,
  RELEASE_STATUSES,
  UPLOAD_TASK_STAGES,
  UPLOAD_TASK_STATUSES,
  USER_STATUS_ENABLED,
} from '../enums';

/** 与数据库设计 §4 的 CHECK 约束逐条对齐：值变了必须先改 DDL */
const DB_CHECK_CONSTRAINTS: Record<string, readonly string[]> = {
  'proto_prototype.status': PROTOTYPE_STATUSES,
  'proto_prototype.access_mode': ACCESS_MODES,
  'proto_release.status': RELEASE_STATUSES,
  'proto_release_event.event_type': RELEASE_EVENT_TYPES,
  'proto_upload_task.status': UPLOAD_TASK_STATUSES,
  'proto_upload_task.stage': UPLOAD_TASK_STAGES,
  'proto_access_log.result': ACCESS_LOG_RESULTS,
  'proto_project_member.member_role': MEMBER_ROLES,
  'sys_role.data_scope': DATA_SCOPES,
  'sys_menu.type': MENU_TYPES,
};

describe('枚举取值', () => {
  it('与 DDL CHECK 约束一致', () => {
    expect(DB_CHECK_CONSTRAINTS['proto_prototype.status']).toEqual([
      'draft',
      'published',
      'archived',
    ]);
    expect(DB_CHECK_CONSTRAINTS['proto_prototype.access_mode']).toEqual([
      'public',
      'password',
      'member',
    ]);
    expect(DB_CHECK_CONSTRAINTS['sys_role.data_scope']).toEqual(['all', 'member', 'own']);
    expect(DB_CHECK_CONSTRAINTS['proto_upload_task.status']).toEqual([
      'pending',
      'processing',
      'success',
      'failed',
      'canceled',
    ]);
  });

  it('每组取值内部无重复', () => {
    for (const [constraint, values] of Object.entries(DB_CHECK_CONSTRAINTS)) {
      expect(new Set(values).size, constraint).toBe(values.length);
    }
    expect(new Set(ACCESS_REASONS).size).toBe(ACCESS_REASONS.length);
    expect(new Set(BUILT_IN_ROLE_CODES).size).toBe(BUILT_IN_ROLE_CODES.length);
  });

  it('内置角色 4 个（权限模型设计 §4）', () => {
    expect([...BUILT_IN_ROLE_CODES]).toEqual([
      'super_admin',
      'admin',
      'publisher',
      'viewer',
    ]);
    expect(USER_STATUS_ENABLED).toBe(1);
  });
});

import { MEMBER_ROLES, PROJECT_STATUSES } from '@protohub/shared';
import { z } from 'zod';

import {
  entityCodeField,
  entityDescriptionField,
  entityNameField,
  immutableField,
} from '../../common/entity-fields';
import { idStringField, optionalQueryText } from '../system/common/dto';

/**
 * 项目接口的请求契约（后端接口设计 §4.1/§4.2）。
 *
 * 字段的通用形态（名称/说明/编码）来自 `common/entity-fields`——原型那一级的规则一模一样。
 * 这里只保留项目特有的部分：编码要查保留字，所以格式判定在 service（`checkCode`），
 * DTO 只管长度上限（varchar(63)）。
 */

const nameField = entityNameField('项目');
const codeField = entityCodeField('项目');
const descriptionField = entityDescriptionField('项目');

export const createProjectSchema = z
  .object({
    name: nameField,
    code: codeField,
    description: descriptionField,
  })
  .strict();

/** §4.1.5：`code` 传了不生效——放行并由 service 回 PROTO_CODE_IMMUTABLE 警告（与角色接口直接 400 不同）。 */
export const updateProjectSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    code: immutableField,
  })
  .strict();

/** PUT /api/projects/{id}/members：覆盖式（§4.1.10）。memberRole 一期只记录不鉴权。 */
export const setProjectMembersSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            userId: idStringField('成员 user id'),
            memberRole: z.enum(MEMBER_ROLES).optional(),
          })
          .strict(),
      )
      .max(500, '单个项目最多 500 名成员')
      .transform((members) => [...new Map(members.map((m) => [m.userId, m])).values()]),
  })
  .strict();

/** 列表筛选（§4.1.1）；分页与排序走公共归一化，不在此重复。 */
export const projectListQuerySchema = z.object({
  keyword: optionalQueryText(60),
  status: z.preprocess(
    (value: unknown) => (value === '' ? undefined : value),
    z.enum(PROJECT_STATUSES).optional(),
  ),
});

/** GET /api/projects/check-code?code=（§4.2：缺省即"留空会生成什么"）。 */
export const projectCodeQuerySchema = z.object({
  code: z.preprocess(
    (value: unknown) => (typeof value === 'string' ? value.trim() : value),
    z.string().max(63).optional(),
  ),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type SetProjectMembersInput = z.infer<typeof setProjectMembersSchema>;
export type ProjectListFilter = z.infer<typeof projectListQuerySchema>;
export type ProjectCodeQuery = z.infer<typeof projectCodeQuerySchema>;

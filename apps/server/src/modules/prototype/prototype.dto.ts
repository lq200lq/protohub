import { ACCESS_MODES, PROTOTYPE_STATUSES } from '@protohub/shared';
import { z } from 'zod';

import {
  entityCodeField,
  entityDescriptionField,
  entityNameField,
  immutableField,
} from '../../common/entity-fields';
import { idStringField, optionalQueryText } from '../system/common/dto';

/**
 * 原型接口的请求契约（后端接口设计 §4.3/§4.4）。
 * 字段形态与项目同源（`common/entity-fields`），差别只在这里多一个 `projectId` 与 `sort`。
 */

const nameField = entityNameField('原型');
const codeField = entityCodeField('原型');
const descriptionField = entityDescriptionField('原型');

/**
 * 密码长度上限：argon2 的耗时随输入线性增长，"拿 10MB 当密码"是 DoS 入口（同 auth.controller 的处理）。
 * 最短 6 位（§4.4）留给 service 判——那里才能挂上 PROTO_POLICY_PASSWORD_INVALID。
 */
const passwordField = z.preprocess(
  (value: unknown) => (typeof value === 'string' ? value.trim() : value),
  z.string().max(72, '访问密码最长 72 个字符').optional(),
);

export const createPrototypeSchema = z
  .object({
    projectId: idStringField('项目 id'),
    name: nameField,
    code: codeField,
    description: descriptionField,
  })
  .strict();

/** §4.3.5：`sort` 是项目内展示顺序；`code` 传了不生效（回 PROTO_CODE_IMMUTABLE 警告）。 */
export const updatePrototypeSchema = z
  .object({
    name: nameField,
    description: descriptionField,
    sort: z.number().int('排序值必须是整数').min(0).max(999_999).optional(),
    code: immutableField,
  })
  .strict();

/**
 * §4.4 访问策略。**没有 `memberIds`**：member 档的可访问人就是父项目成员（权限模型 §6.2 原型不单独判
 * 数据权限，库里也没有原型级成员表），传它无处可落，所以 strict() 直接拒——静默忽略一个不生效的字段，
 * 比报错更难被发现。
 */
export const setPrototypePolicySchema = z
  .object({
    accessMode: z.enum(ACCESS_MODES),
    password: passwordField,
  })
  .strict();

/** §4.3.1 列表**必须带 projectId**：没有它就没法用 (project_id, sort) 索引，也会变成全库原型列表。 */
export const prototypeListQuerySchema = z.object({
  projectId: idStringField('项目 id'),
  keyword: optionalQueryText(60),
  status: z.preprocess(
    (value: unknown) => (value === '' ? undefined : value),
    z.enum(PROTOTYPE_STATUSES).optional(),
  ),
});

/** GET /api/prototypes/check-code?projectId=&code=（§4.3.2，项目内唯一）。 */
export const prototypeCodeQuerySchema = z.object({
  projectId: idStringField('项目 id'),
  code: entityCodeField('原型'),
});

export type CreatePrototypeInput = z.infer<typeof createPrototypeSchema>;
export type UpdatePrototypeInput = z.infer<typeof updatePrototypeSchema>;
export type SetPrototypePolicyInput = z.infer<typeof setPrototypePolicySchema>;
export type PrototypeListFilter = z.infer<typeof prototypeListQuerySchema>;
export type PrototypeCodeQuery = z.infer<typeof prototypeCodeQuerySchema>;

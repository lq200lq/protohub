import { DATA_SCOPES, USER_STATUSES } from '@protohub/shared';
import { z } from 'zod';

/**
 * 系统管理·角色的请求契约（后端接口设计 §7.2）。
 * 字段形态与 @protohub/shared 的 `CreateRoleParams`/`UpdateRoleParams`/`AssignRolePermissionsParams` 对齐，
 * 本文件只补服务端才需要的约束；一律 `.strict()`，多余字段直接拒绝。
 */

/** 角色标识：小写字母开头，允许数字/下划线/短横线（与内置 code 同风格，库里唯一索引建在 code 原值上）。 */
export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_-]{1,49}$/;

export function isRoleCodeValid(value: string): boolean {
  return ROLE_CODE_PATTERN.test(value);
}

const codeField = z
  .string()
  .trim()
  .regex(ROLE_CODE_PATTERN, '角色标识需 2~50 位，小写字母开头，只含小写字母、数字、下划线、短横线');

const nameField = z.string().trim().min(1, '角色名称不能为空').max(50);

const dataScopeField = z.enum(DATA_SCOPES);

const sortField = z.coerce.number().int().min(0).max(9999);

const remarkField = z.preprocess((value: unknown) => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}, z.string().max(200).nullable().optional());

const statusField = z
  .union([z.literal(0), z.literal(1)])
  .refine((value): value is 0 | 1 => (USER_STATUSES as readonly number[]).includes(value));

const idField = z.string().trim().regex(/^\d{1,19}$/, 'id 必须是数字字符串');

const permissionCodesField = z
  .array(z.string().trim().min(1).max(80))
  .max(200, '一次最多分配 200 个权限码')
  .transform((codes) => [...new Set(codes)]);

const menuIdsField = z
  .array(idField)
  .max(300, '一次最多分配 300 个菜单')
  .transform((ids) => [...new Set(ids)]);

/** 编辑接口"传了就报错"的不可改字段（C-1 的 code 部分由 DTO 前置拦住，服务层再兜一道）。 */
const immutableField = (label: string): z.ZodType<unknown> =>
  z
    .unknown()
    .optional()
    .refine((value) => value === undefined, { message: `${label}不可修改` });

export const createRoleSchema = z
  .object({
    code: codeField,
    name: nameField,
    dataScope: dataScopeField,
    sort: sortField.optional(),
    remark: remarkField.optional(),
    // builtIn 由 seed 决定，接口永远不接受外部声明"我是内置角色"。
    builtIn: immutableField('内置标记（builtIn）'),
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: nameField,
    dataScope: dataScopeField,
    sort: sortField.optional(),
    status: statusField.optional(),
    remark: remarkField.optional(),
    code: immutableField('角色标识（code）'),
    builtIn: immutableField('内置标记（builtIn）'),
  })
  .strict();

export const assignRolePermissionsSchema = z
  .object({
    permissionCodes: permissionCodesField,
    menuIds: menuIdsField,
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type AssignRolePermissionsInput = z.infer<typeof assignRolePermissionsSchema>;

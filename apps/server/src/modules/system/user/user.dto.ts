import { USER_STATUSES } from '@protohub/shared';
import { z } from 'zod';

import { optionalQueryId, optionalQueryText } from '../common/dto';

/**
 * 系统管理·用户的请求契约（后端接口设计 §7.1）。
 *
 * 字段形态与 @protohub/shared 的 `CreateUserParams`/`UpdateUserParams` 对齐（前端 import 同一份定义），
 * 本文件只补"服务端才需要"的约束：长度上限取自 数据库设计 §4.1.1 的 varchar 定义——
 * 超了会在 DB 层变成截断或 500，在 zod 层则是一句能看的 400。
 * 一律 `.strict()`：多余字段直接拒绝，避免前端把 `username`/`password` 悄悄塞进更新请求。
 */

/** 用户名：3~50 位、字母开头，允许 `.`/`_`/`-`（库里唯一性建在 lower(username) 上，所以大小写允许混用但原样存）。 */
export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,49}$/;

const usernameField = z.string().trim().regex(
  USERNAME_PATTERN,
  '用户名需 3~50 位，以字母开头，只能包含字母、数字、点、下划线、短横线',
);

const realNameField = z.string().trim().min(1, '姓名不能为空').max(50);

/** 空串视为未填（表单清空后 antd 传的是 ''，不是 undefined）。 */
const optionalText = (
  max: number,
  pattern?: { readonly regex: RegExp; readonly message: string },
): z.ZodType<string | null | undefined> =>
  z
    .preprocess((value: unknown) => {
      if (typeof value !== 'string') {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }, z.string().max(max).nullable().optional())
    .refine(
      (value) => value === null || value === undefined || pattern === undefined
        ? true
        : pattern.regex.test(value),
      pattern?.message ?? '格式不正确',
    ) as z.ZodType<string | null | undefined>;

const emailField = optionalText(120, {
  regex: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  message: '邮箱格式不正确',
});

const phoneField = optionalText(20, {
  regex: /^[0-9+\-() ]{6,20}$/,
  message: '电话应为 6~20 位数字（可含 +、-、括号）',
});

const remarkField = optionalText(200);

/** 字符串形式的数字 id：后端接口设计 §1.1 规定 bigint 序列化成 string。 */
const idField = z.string().trim().regex(/^\d{1,19}$/, 'id 必须是数字字符串');

const roleIdsField = z
  .array(idField)
  .max(50, '一次最多关联 50 个角色')
  .transform((ids) => [...new Set(ids)]);

const statusField = z
  .union([z.literal(0), z.literal(1)])
  .refine((value): value is 0 | 1 => (USER_STATUSES as readonly number[]).includes(value));

/** 编辑接口里"传了就报错"的不可改字段（比 .strict() 的 Unrecognized key 更好解释）。 */
const immutableField = (label: string): z.ZodType<unknown> =>
  z
    .unknown()
    .optional()
    .refine((value) => value === undefined, { message: `${label}不可修改` });

export const createUserSchema = z
  .object({
    username: usernameField,
    realName: realNameField,
    email: emailField,
    phone: phoneField,
    roleIds: roleIdsField,
    remark: remarkField,
    // 明文密码由服务端生成（§7.1.2），接口不接受密码字段：一旦允许就等于开了"管理员设定他人弱密码"的口子。
    password: immutableField('初始密码（由服务端随机生成）'),
  })
  .strict();

export const updateUserSchema = z
  .object({
    realName: realNameField,
    email: emailField,
    phone: phoneField,
    status: statusField,
    remark: remarkField,
    username: immutableField('用户名'),
  })
  .strict();

/** 启停：§7.1.4 的 status 单独成动作，界面用开关直调，不必回传整份表单。 */
export const setUserStatusSchema = z
  .object({ status: statusField })
  .strict();

export const assignRolesSchema = z.object({ roleIds: roleIdsField }).strict();

/** 列表筛选（§7.1.1：keyword / status / roleId；分页参数交给公共归一化）。 */
export const userListQuerySchema = z.object({
  keyword: optionalQueryText(60),
  roleId: optionalQueryId(),
  status: z.preprocess(
    (value: unknown) => (value === '' ? undefined : value),
    z.coerce
      .number()
      .int()
      .refine(
        (value: number) => (USER_STATUSES as readonly number[]).includes(value),
        'status 只能是 0（禁用）或 1（启用）',
      )
      .optional(),
  ),
});

/** 本人改资料（§2.7：只有这四个字段可改）。 */
export const updateProfileSchema = z
  .object({
    realName: realNameField,
    email: emailField,
    phone: phoneField,
    avatar: optionalText(500, {
      regex: /^(https?:\/\/|\/)/,
      message: '头像必须是 http(s) 地址或站内路径',
    }),
    username: immutableField('用户名'),
    roleIds: immutableField('角色（请走系统管理·用户）'),
  })
  .strict();

/** 本人改密码（§2.8）。强度校验在服务层做（要和新密码生成器共用同一套判定）。 */
export const changePasswordSchema = z
  .object({
    oldPassword: z.string().min(1, '请输入当前密码').max(200),
    newPassword: z.string().min(1, '请输入新密码').max(200),
  })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SetUserStatusInput = z.infer<typeof setUserStatusSchema>;
export type AssignRolesInput = z.infer<typeof assignRolesSchema>;
export type UserListFilterInput = z.infer<typeof userListQuerySchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;


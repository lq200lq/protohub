import { MENU_TYPES, USER_STATUSES, isPermissionCode } from '@protohub/shared';
import { z } from 'zod';

/**
 * 系统管理·菜单的请求契约（后端接口设计 §7.3，字段与 sys_menu 一一对应，见数据库设计 §4.1.6）。
 *
 * 两条服务端口径：
 * - `auth_code`：button 节点携带的权限码**必须存在于 PERMISSIONS 常量**（权限模型设计 §3.7），
 *   否则前端 v-access 码永远配不上——这里直接拒。
 * - `component`：只做**形态校验**（相对 apps/admin/src/views 的路径或固定布局组件名）；
 *   "文件是否真的存在"属于一致性脚本（check-consistency）的职责，不在 CRUD 接口里查磁盘。
 */

/** 路由 name：字母开头、驼峰、全局唯一（库里 uk_sys_menu_name）。 */
const nameField = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/, '路由 name 需为字母开头、仅含字母数字（PascalCase）');

const titleField = z.string().trim().min(1, '标题不能为空').max(80);

const typeField = z.enum(MENU_TYPES);

/** 空串视为未填（表单清空后 antd 传 ''）。 */
const optionalText = (max: number, pattern?: { readonly regex: RegExp; readonly message: string }): z.ZodType<string | null | undefined> =>
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

/** 路由 path：站内绝对路径（button 节点为空）。 */
const pathField = optionalText(200, {
  regex: /^\/[A-Za-z0-9._\-/]*$/,
  message: 'path 需为以 / 开头的站内路径',
});

/**
 * component 形态：`/proto/project/index` 这类视图路径（不允许 `..` 上跳，防止越出 views 目录），
 * 或 `BasicLayout`/`IFrameView` 这类大写开头的固定组件名。
 */
const COMPONENT_PATTERN = /^(?:\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|[A-Z][A-Za-z0-9]*)$/;
const componentField = optionalText(200, {
  regex: COMPONENT_PATTERN,
  message: 'component 需为 / 开头的视图路径（不含 ..）或大写开头的组件名，如 /proto/project/index 或 BasicLayout',
}).refine(
  (value) => !(typeof value === 'string' && value.split('/').includes('..')),
  'component 不允许包含 .. 上跳路径',
);

const authCodeField = optionalText(80)
  .refine(
    (value) => value === null || value === undefined || isPermissionCode(value),
    'auth_code 必须是 PERMISSIONS 字典中定义的权限码（新增按钮权限需先加代码常量并 seed）',
  );

/** URL 类字段：http(s) 绝对地址或站内路径。 */
const urlField = (max: number) => optionalText(max, {
  regex: /^(https?:\/\/|\/)/,
  message: '需为 http(s) 地址或站内路径',
});

/** 逗号分隔的角色标识串（下发前端时转数组，见 shared MenuTreeNode.authority）。 */
const authorityField = optionalText(200, {
  regex: /^[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*$/,
  message: 'authority 需为逗号分隔的角色标识',
});

const idField = z.string().trim().regex(/^\d{1,19}$/, 'id 必须是数字字符串');

const booleanField = z.boolean().optional();

const sortField = z.coerce.number().int().min(0).max(9999).optional();

const statusField = z
  .union([z.literal(0), z.literal(1)])
  .refine((value): value is 0 | 1 => (USER_STATUSES as readonly number[]).includes(value))
  .optional();

export const menuFormSchema = z
  .object({
    type: typeField,
    name: nameField,
    title: titleField,
    path: pathField,
    component: componentField,
    authCode: authCodeField,
    icon: optionalText(80),
    pid: idField.nullable().optional(),
    sort: sortField,
    status: statusField,
    keepAlive: booleanField,
    affixTab: booleanField,
    hideInMenu: booleanField,
    menuVisibleWithForbidden: booleanField,
    ignoreAccess: booleanField,
    openInNewWindow: booleanField,
    authority: authorityField,
    iframeSrc: urlField(500),
    linkUrl: urlField(500),
    badge: optionalText(20),
    badgeType: optionalText(20),
  })
  .strict();

/** 启停（与用户 §7.1.4 的 status 动作化同一模式：界面开关直调，不回传整表单）。 */
export const setMenuStatusSchema = z
  .object({ status: z.union([z.literal(0), z.literal(1)]) })
  .strict();

export type MenuFormInput = z.infer<typeof menuFormSchema>;
export type SetMenuStatusInput = z.infer<typeof setMenuStatusSchema>;

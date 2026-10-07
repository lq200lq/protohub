import { z } from 'zod';

/**
 * 业务实体的公共字段契约（数据库设计 §4.2.1/§4.2.2：项目与原型的 name/description/code 同构）。
 *
 * 放在 `common/` 而不是某个模块里：项目与原型是同一套形态的两级容器，字段规则只差一个名词，
 * 抄两遍的话"改一处忘改另一处"会直接变成两边校验行为不一致（§3.7 通用能力收敛一处）。
 */

/** 名称：非空、最长 80（varchar(80)）。 */
export const entityNameField = (label: string): z.ZodString =>
  z
    .string()
    .trim()
    .min(1, `${label}名称不能为空`)
    .max(80, `${label}名称最长 80 个字符`);

/** 说明：可选，'' 归一成 null（后端接口设计 §1.5：可选字段缺省返回 null，不返回 undefined）。 */
export const entityDescriptionField = (label: string): z.ZodType<null | string | undefined, z.ZodTypeDef, unknown> =>
  z.preprocess(
    (value: unknown) =>
      typeof value === 'string' && value.trim() === '' ? null : value,
    z.string().max(500, `${label}说明最长 500 个字符`).nullable().optional(),
  );

/**
 * 编码：可选，'' 是"请帮我生成"的信号（决策 D-20），所以这里**不判格式**。
 * 格式/保留字/占用属于业务判定，归 service（它才知道要报"已被谁占用"这种带上下文的话）。
 */
export const entityCodeField = (label: string): z.ZodType<string | undefined, z.ZodTypeDef, unknown> =>
  z.preprocess(
    (value: unknown) => (typeof value === 'string' ? value.trim() : value),
    z.string().max(63, `${label}编码最长 63 个字符`).optional(),
  );

/** 编辑接口里"传了也不生效"的字段：放行后由 service 记警告，而不是让老表单提交失败。 */
export const immutableField = z.unknown().optional();

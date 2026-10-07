import { ERROR_CODES, type ReleaseUploadRefPayload } from '@protohub/shared';
import { z } from 'zod';

import { BusinessException } from '../../common/exception/business.exception';
import {
  entityCodeField,
  entityDescriptionField,
  entityNameField,
} from '../../common/entity-fields';
import { IDEMPOTENCY_KEY_MAX_LENGTH } from '../../config/constants';
import { optionalQueryBoolean, parseWithSchema } from '../system/common/dto';

/**
 * POST /api/releases 的表单契约（后端接口设计 §5.1）。
 *
 * multipart 的文本字段全是字符串，`project`/`prototype` 还是字符串里装的 JSON，
 * 所以这里分两步：先按 §5.1 的字段名收齐原文（`uploadFormFieldsSchema`），
 * 再由 `resolveUploadForm()` 解 JSON + 判"三选一"。
 *
 * 为什么把三选一写成显式函数而不是 zod 的 union：§5.1 的三种场景互斥，而矛盾组合要**报出矛盾在哪**
 * （同时给 `prototypeId` 和 `prototype` 时，用户需要知道自己到底填了哪一格）；zod 的 union 只会说"参数不合法"。
 */

/** §5.1 的非文件字段名；`file` 由 intake 单独处理，出现在别的字段名上一律拒。 */
export const UPLOAD_FORM_FIELDS = [
  'force',
  'note',
  'project',
  'projectId',
  'prototype',
  'prototypeId',
] as const;

/** `note` 是版本说明，§5.1 限定 ≤300 字（`proto_release.note` 是 varchar(300)）。 */
const noteField = z.preprocess(
  (value: unknown) => (typeof value === 'string' ? value.trim() : value),
  z.string().max(300, '版本说明最长 300 个字符').optional(),
);

/**
 * GET /api/releases/link-preview 的查询参数（接口设计 §5.9）。
 * 这里只收"有值且不太长"，格式判定留给服务层的 `assert*CodeFormat`——
 * 它与新建/受理用的是同一句话术，预览和提交不会报出两种不同的编码错误。
 */
export const linkPreviewQuerySchema = z
  .object({
    projectCode: z.string().min(1).max(63),
    prototypeCode: z.string().min(1).max(63),
  })
  .strict();

/** 收原文：所有值都还是字符串（`force` 例外，`optionalQueryBoolean` 已兼容 'true'/'1'/布尔）。 */
export const uploadFormFieldsSchema = z
  .object({
    force: optionalQueryBoolean(),
    note: noteField,
    project: z.string().optional(),
    projectId: z.string().optional(),
    prototype: z.string().optional(),
    prototypeId: z.string().optional(),
  })
  .strict();

/**
 * `project` / `prototype` 两个 JSON 字段里的形态（§5.1）。
 * 字段规则与新建项目/新建原型同源（`common/entity-fields`），由 label 决定话术名词。
 */
function refSchema(label: string) {
  return z
    .object({
      code: entityCodeField(label),
      description: entityDescriptionField(label),
      name: entityNameField(label),
    })
    .strict();
}

/** 判定后的场景：`kind` 直接对应机制 §3.0 那个事务里要插哪几张表。 */
export type PublishTarget =
  | { readonly kind: 'append'; readonly prototypeId: string }
  | {
      readonly kind: 'createPrototype';
      readonly projectId: string;
      readonly prototype: ReleaseUploadRefPayload;
    }
  | {
      readonly kind: 'createProject';
      readonly project: ReleaseUploadRefPayload;
      readonly prototype: ReleaseUploadRefPayload;
    };

export interface ReleaseUploadInput {
  readonly force: boolean;
  readonly idempotencyKey: string | null;
  readonly note: string | null;
  readonly target: PublishTarget;
}

function badForm(message: string): BusinessException {
  return new BusinessException(message, ERROR_CODES.PARAM_INVALID, 400);
}

/**
 * 解一个 JSON 编码的引用字段。
 * 报错话术带字段名（"请用 prototype 字段给出…" 比 `参数不合法` 更知道补哪一格），JSON 解析失败单独说，
 * 免得被截断/写坏的 JSON 报成"name 不能为空"这种看不出根因的提示。
 *
 * 两个调用点（project / prototype）都只在"该场景必须要这个字段"时走到这里，所以没有"可空"分支：
 * 留一条永远走不到的 optional 路径，只会让后面的判定以为真的存在"没给但也不报错"的第三种情况。
 */
function decodeRef(
  label: string,
  field: string,
  raw: string | undefined,
): ReleaseUploadRefPayload {
  const text = raw?.trim() ?? '';
  if (text === '') {
    throw badForm(`请用 ${field} 字段给出${label}信息（JSON：name/code/description）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badForm(`${field} 字段不是合法的 JSON`);
  }
  const value = parseWithSchema(refSchema(label), parsed);
  return {
    code: value.code,
    description: value.description ?? undefined,
    name: value.name,
  };
}

/**
 * §5.1 的三选一 → 一个明确场景。矛盾组合一律 400，不猜用户想干什么：
 * 猜错的代价是"在别人没料到的项目下多了一个原型"，比一次失败重填难得多。
 */
function resolveTarget(form: z.infer<typeof uploadFormFieldsSchema>): PublishTarget {
  const prototypeId = form.prototypeId?.trim() ?? '';
  const projectId = form.projectId?.trim() ?? '';
  const hasProject = (form.project?.trim() ?? '') !== '';
  const hasPrototype = (form.prototype?.trim() ?? '') !== '';

  if (prototypeId !== '') {
    if (projectId !== '' || hasProject || hasPrototype) {
      throw badForm(
        '已指定原型时不能再带 project/prototype/projectId——发新版本只需要文件与可选的 note',
      );
    }
    // id 的格式判定留给服务层的 `parseIdParam`：那里的话术带字段名，且统一是 BusinessException。
    return { kind: 'append', prototypeId };
  }

  // 矛盾组合先报：它说明用户还没想清楚要发到哪，此时报"缺 prototype"只会让人更糊涂。
  if (projectId !== '' && hasProject) {
    throw badForm('projectId 与 project 只能二选一：要么挂到已有项目，要么新建项目');
  }

  const prototype = decodeRef('原型', 'prototype', form.prototype);
  if (projectId !== '') {
    return { kind: 'createPrototype', projectId, prototype };
  }
  return { kind: 'createProject', project: decodeRef('项目', 'project', form.project), prototype };
}

/** 表单原文 + 幂等键 → 服务层可直接用的受理输入。 */
export function resolveUploadForm(
  fields: Readonly<Record<string, string>>,
  idempotencyKey?: string,
): ReleaseUploadInput {
  const form = parseWithSchema(uploadFormFieldsSchema, { ...fields });
  const key = idempotencyKey?.trim() ?? '';
  return {
    force: form.force ?? false,
    // §1.5 的幂等键是前端生成的 UUID，长键一律截断而不是报错：报 400 会让用户以为提交失败。
    idempotencyKey: key === '' ? null : key.slice(0, IDEMPOTENCY_KEY_MAX_LENGTH),
    note: form.note ?? null,
    target: resolveTarget(form),
  };
}

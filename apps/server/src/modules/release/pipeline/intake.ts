import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import {
  MULTIPART_MAX_FIELDS,
  UPLOAD_SOURCE_NAME_MAX_LENGTH,
} from '../../../config/constants';
import { storageRandom } from '../../storage/local-storage.adapter';
import { requireLocalPath, type StorageAdapter } from '../../storage/storage.adapter';
import { uploadPendingKey } from '../../storage/storage-keys';
import { UPLOAD_FORM_FIELDS } from '../release.dto';
import { uploadRejected, type UploadLimits } from './errors';

/**
 * 上传受理的流式落盘（机制 §2.1 的 ①，接口设计 §5.1 的"流式落临时文件"）。
 *
 * 只做三件事：**收字段 → 边写盘边算 sha256 → 交出绝对路径与指纹**。
 * 内容校验一律不在这里做（§5.2：解压耗时不可控，不能塞进请求）；这里只保证拿到的是一个
 * 完整、未超限、有指纹的本地文件。
 *
 * 为什么自己遍历 `parts()` 而不用 `req.file()`/`attachFieldsToBody`：busboy 按报文顺序消费，
 * 文件之后的字段必须先读完才可见；一次遍历同时拿到字段和文件，才不用赌前端把谁排在前面。
 *
 * 落盘失败（超限、异常）时**必须删掉半截文件**：`tmp/` 里留着没人引用的文件只能等 GC，
 * 而这里是同步请求路径，能当场清干净就别留给运维。
 */

/** 文件分片：只声明用到的成员，不把 busboy/fastify 的适配器类型泄漏进业务代码（同 common/http-types.ts 的取舍）。 */
interface FilePartLike {
  readonly fieldname: string;
  readonly file?: NodeJS.ReadableStream & { readonly truncated?: boolean };
  readonly filename?: string;
  readonly type: 'file';
}

/** 普通表单字段。`valueTruncated` 是 busboy 在 `limits.fieldSize` 处截断的标记。 */
interface FieldPartLike {
  readonly fieldname: string;
  readonly type: 'field';
  readonly value?: string;
  readonly valueTruncated?: boolean;
}

export type UploadPart = FieldPartLike | FilePartLike;

/** `@fastify/multipart` 给请求加上的两个方法（同样只声明用到的部分）。 */
export interface MultipartRequestLike {
  isMultipart(): boolean;
  parts(): AsyncIterable<UploadPart>;
}

export interface IntakeResult {
  /** 临时文件的绝对路径，供 §2.2 的轻校验直接读。 */
  readonly absPath: string;
  /** §5.1 的非文件字段原文，交给 DTO 解析。 */
  readonly fields: Readonly<Record<string, string>>;
  /** 过渡 key（`uploadPendingKey`）：受理事务提交后 rename 成 §1.2 的正式名。 */
  readonly pendingKey: string;
  /** 随机后缀：正式名 `upload-{taskId}-{random}` 沿用同一个值，排查时两个名字能对上。 */
  readonly random: string;
  /** 原始 zip 的 sha256 → 受理阶段的 §2.7 去重判定（`proto_release.source_hash` 由 Worker 在 postprocess 算）。 */
  readonly sourceHash: string;
  /** 落盘字节数。 */
  readonly sourceSize: number;
  /** 上传文件名（进 `proto_upload_task.source_name`，已收敛到 300 字符）。 */
  readonly sourceName: string;
}

const FILE_FIELD = 'file';

/** 文件名只取 basename：浏览器一般会带，但手工构造的请求可以塞 `../../x.zip`。 */
function safeSourceName(filename: string): string {
  const cleaned = basename(filename.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return cleaned.slice(0, UPLOAD_SOURCE_NAME_MAX_LENGTH);
}

export async function intakeUpload(
  request: MultipartRequestLike,
  storage: StorageAdapter,
  limits: UploadLimits,
): Promise<IntakeResult> {
  if (!request.isMultipart()) {
    throw new BusinessException(
      '上传发布要用 multipart/form-data 提交',
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }

  const random = storageRandom();
  const pendingKey = uploadPendingKey(random);
  const absPath = requireLocalPath(storage, pendingKey);

  const fields: Record<string, string> = {};
  let file: FilePartLike | undefined;
  let hash: ReturnType<typeof createHash> | undefined;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = takeField(fields, part);
        continue;
      }
      if (part.fieldname !== FILE_FIELD) {
        throw new BusinessException(
          `未知的表单文件字段「${part.fieldname}」，只接受「${FILE_FIELD}」`,
          ERROR_CODES.PARAM_INVALID,
          400,
        );
      }
      if (file !== undefined) {
        // 当前接线（`files: 1`）下生产报文会先撞解析器那道，走 translateParserError 回到同一句话；
        // 这道自留判断保证换了接线也是同一句话。
        throw oneFileOnly();
      }
      file = part;
      const stream = part.file;
      if (!stream) {
        throw noFile();
      }
      const digest = createHash('sha256');
      hash = digest;
      await pipeline(
        stream,
        new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            digest.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(absPath),
      );
      if (stream.truncated === true) {
        throw uploadRejected(ERROR_CODES.UPLOAD_TOO_LARGE, limits);
      }
    }

    if (file === undefined || hash === undefined) {
      throw noFile();
    }
    const sourceName = safeSourceName(file.filename ?? '');
    if (sourceName === '') {
      throw new BusinessException(
        '文件名不能为空',
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    const size = (await stat(absPath)).size;
    if (size > limits.maxUploadBytes) {
      throw uploadRejected(ERROR_CODES.UPLOAD_TOO_LARGE, limits);
    }
    return {
      absPath,
      fields,
      pendingKey,
      random,
      sourceHash: hash.digest('hex'),
      sourceName,
      sourceSize: size,
    };
  } catch (error: unknown) {
    await rm(absPath, { force: true }).catch(() => undefined);
    throw translateParserError(error);
  }
}

function noFile(): BusinessException {
  return new BusinessException(
    `缺少上传文件（字段名必须是「${FILE_FIELD}」）`,
    ERROR_CODES.PARAM_INVALID,
    400,
  );
}

function oneFileOnly(): BusinessException {
  return new BusinessException('一次只能上传一个 zip 文件', ERROR_CODES.PARAM_INVALID, 400);
}

/**
 * 把 multipart 解析器自己就拒绝的请求翻译成人话（接口 §1.4：400 = 参数不合法）。
 *
 * 这些限额错误是 `parts()` 当成"下一个分片"抛出来的 FastifyError，走不到本函数里那些
 * 自己的判定；不翻译就会被异常过滤器归为未知错误回 500——而 500 会让用户以为平台坏了，
 * 于是对着一个必然失败的请求反复重试。
 *
 * 只列**当前接线真能触发**的四种：`main.ts` 设了 `files: 1`/`fields` 限额，
 * `throwFileSizeLimit: false` 又保证超尺寸走的是 `truncated`（413 UPLOAD_TOO_LARGE，
 * 由下面循环自己判定），所以 `FST_REQ_FILE_TOO_LARGE` 到不了这里。其余错误原样抛出：
 * 把框架的内部故障也洗成 400，等于把 bug 藏进"用户参数不对"里。
 */
function translateParserError(error: unknown): unknown {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case 'FST_FILES_LIMIT': {
      return oneFileOnly();
    }
    case 'FST_FIELDS_LIMIT': {
      return new BusinessException(
        `表单字段过多（最多 ${MULTIPART_MAX_FIELDS} 个）`,
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    case 'FST_PROTO_VIOLATION': {
      return new BusinessException(
        '字段名不合法',
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    case 'FST_INVALID_JSON_FIELD_ERROR': {
      return new BusinessException(
        '字段内容不是合法 JSON，或长度超出上限（project / prototype 要提交 JSON）',
        ERROR_CODES.PARAM_INVALID,
        400,
      );
    }
    default: {
      return error;
    }
  }
}

/**
 * 收下一个字段值。
 *
 * 白名单外的字段直接拒而不是忽略：接口设计 §1.4 把 400 留给"参数不合法"，而 DTO 全是
 * `.strict()`，这里放行只会让后面的解析报出一句更难懂的话。
 * 截断（`valueTruncated`）必须单独报——`project`/`prototype` 是被截断的 JSON，
 * 交给解析层只会得到"参数不合法：project：..." 这种看不出根因的提示。
 */
function takeField(
  fields: Readonly<Record<string, string>>,
  part: FieldPartLike,
): string {
  if (!(UPLOAD_FORM_FIELDS as readonly string[]).includes(part.fieldname)) {
    throw new BusinessException(
      `不支持提交「${part.fieldname}」字段`,
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  if (Object.prototype.hasOwnProperty.call(fields, part.fieldname)) {
    throw new BusinessException(
      `字段「${part.fieldname}」重复提交`,
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  if (part.valueTruncated === true) {
    throw new BusinessException(
      `字段「${part.fieldname}」内容过长，已被截断`,
      ERROR_CODES.PARAM_INVALID,
      400,
    );
  }
  return part.value ?? '';
}

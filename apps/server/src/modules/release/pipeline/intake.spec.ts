import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@protohub/shared';

import { BusinessException } from '../../../common/exception/business.exception';
import { MULTIPART_MAX_FIELDS } from '../../../config/constants';
import { type StorageAdapter } from '../../storage/storage.adapter';
import { TMP_PREFIX } from '../../storage/storage-keys';
import { intakeUpload, type UploadPart } from './intake';
import type { UploadLimits } from './errors';

/**
 * 上传受理的流式落盘单测（机制 §2.1 的 ①，计划 M3-T2）。
 *
 * 桩掉的是 fastify/busboy（用异步生成器造分片）与存储根目录（映射到真实临时目录），
 * 钉住的五条都是"只有 intake 负责"的事：
 * 1. 超限分片要变成 §8 的 **413**，而不是 busboy 的通用错误（`throwFileSizeLimit:false` + `truncated`）；
 * 2. 字段被截断要单独报，不能让它变成"JSON 不合法"这种看不出根因的提示；
 * 3. 白名单外/重复/缺失/多余的字段一律 400；
 * 4. **任何失败路径都要把半截文件删掉**——受理是同步请求，能当场清干净就别留给 GC；
 * 5. 解析器自己抛的限额错误也要落到 400 话术上（真实报文实测：漏翻译一次就回 500）。
 */

const LIMITS: UploadLimits = {
  maxEntries: 5000,
  maxFileBytes: 20 * 1024 * 1024,
  maxRatio: 50,
  maxTotalBytes: 500 * 1024 * 1024,
  maxUploadBytes: 1024,
};

const CONTENT = Buffer.from('PK\x03\x04 fake zip body', 'utf8');

interface Harness {
  readonly root: string;
  readonly storage: StorageAdapter;
}

/**
 * 每次用例一个独立临时目录：断言"目录里还剩什么"才有意义。
 * `tmp/` 先建好——真实实现的目录布局由 `LocalStorageAdapter.onModuleInit` 在启动时自建（M3-T1），
 * intake 只往既有布局里写文件，不该自己造目录。
 */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'protohub-intake-'));
  await mkdir(join(root, TMP_PREFIX), { recursive: true });
  return {
    root,
    storage: {
      localPathOf: (key: string): string | null => join(root, key),
    } as unknown as StorageAdapter,
  };
}

interface FilePartOptions {
  readonly chunk?: Buffer;
  readonly fieldname?: string;
  readonly filename?: string;
  readonly truncated?: boolean;
}

function filePart(options: FilePartOptions = {}): UploadPart {
  const stream = Object.assign(Readable.from([options.chunk ?? CONTENT]), {
    truncated: options.truncated ?? false,
  });
  return {
    fieldname: options.fieldname ?? 'file',
    file: stream,
    filename: options.filename ?? 'login-flow.zip',
    type: 'file',
  };
}

function field(name: string, value: string, truncated = false): UploadPart {
  return { fieldname: name, type: 'field', value, valueTruncated: truncated };
}

function requestOf(parts: readonly UploadPart[], multipart = true) {
  return {
    async *parts(): AsyncGenerator<UploadPart> {
      for (const part of parts) {
        yield part;
      }
    },
    isMultipart(): boolean {
      return multipart;
    },
  };
}

/**
 * `@fastify/multipart` 的限额错误是**当成下一个分片抛出来的**（`parts()` reject），
 * 不是普通分片：`files: 1` 命中第二个文件时，我们的循环连那个分片都看不到。
 * 真实 HTTP 报文就是这么进来的，所以桩也得从迭代器里抛。
 */
function requestWithParserError(code: string, before: readonly UploadPart[] = []) {
  return {
    async *parts(): AsyncGenerator<UploadPart> {
      for (const part of before) {
        yield part;
      }
      throw Object.assign(new Error(`reach ${code} in parser`), { code, statusCode: 413 });
    },
    isMultipart(): boolean {
      return true;
    },
  };
}

async function rejectionFromParser(
  code: string,
  before: readonly UploadPart[] = [],
): Promise<BusinessException> {
  const { root, storage } = await harness();
  try {
    await intakeUpload(requestWithParserError(code, before), storage, LIMITS);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BusinessException);
    // 解析器报的错同样要清掉已经写了一半的文件，否则 tmp/ 里只会攒垃圾。
    expect(await readdir(join(root, TMP_PREFIX))).toEqual([]);
    return error as BusinessException;
  }
  throw new Error(`${code} 本该被拒绝，却受理成功了`);
}

/** 被拒的报文必须一个字节都不留在临时目录里（失败还留半截文件 = 只能等 GC 的运维债）。 */
async function expectRejection(
  parts: readonly UploadPart[],
  multipart = true,
): Promise<BusinessException> {
  const { root, storage } = await harness();
  try {
    await intakeUpload(requestOf(parts, multipart), storage, LIMITS);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BusinessException);
    expect(await readdir(join(root, TMP_PREFIX))).toEqual([]);
    return error as BusinessException;
  }
  throw new Error('这批分片本该被拒绝，却受理成功了');
}

describe('intakeUpload：收齐分片并算出指纹', () => {
  it('写盘内容、字节数与 sha256 一致，字段原文交回 DTO', async () => {
    const { root, storage } = await harness();
    const result = await intakeUpload(
      requestOf([field('prototypeId', '31'), field('note', '改了配色'), filePart()]),
      storage,
      LIMITS,
    );

    expect(result.fields).toEqual({ note: '改了配色', prototypeId: '31' });
    expect(result.sourceSize).toBe(CONTENT.byteLength);
    expect(result.sourceHash).toBe(createHash('sha256').update(CONTENT).digest('hex'));
    expect(result.sourceName).toBe('login-flow.zip');
    expect(result.pendingKey).toMatch(/^tmp\/upload-pending-[0-9a-z]{8}\.zip$/);
    expect(result.random).toMatch(/^[0-9a-z]{8}$/);
    // pendingKey / absPath / random 指向同一个文件，提交后的 rename 才搬得对东西。
    expect(result.absPath).toBe(join(root, result.pendingKey));
    expect(await readFile(result.absPath)).toEqual(CONTENT);
  });

  it('文件名只取 basename：手工报文塞 ../../ 也逃不出存储根目录', async () => {
    const { storage } = await harness();
    const result = await intakeUpload(
      requestOf([filePart({ filename: '../../../../etc/passwd.zip' })]),
      storage,
      LIMITS,
    );
    expect(result.sourceName).toBe('passwd.zip');
  });

  it('非 multipart 请求直接 400，不落任何文件', async () => {
    const error = await expectRejection([], false);
    expect(error.httpStatus).toBe(400);
    expect(error.errorCode).toBe(ERROR_CODES.PARAM_INVALID);
    expect(error.message).toContain('multipart/form-data');
  });
});

describe('intakeUpload：超限与截断的话术（§8）', () => {
  it('分片被 busboy 截断 → 413 UPLOAD_TOO_LARGE，并按阈值给出人话上限', async () => {
    const error = await expectRejection([filePart({ truncated: true })]);
    expect(error.httpStatus).toBe(413);
    expect(error.errorCode).toBe(ERROR_CODES.UPLOAD_TOO_LARGE);
    expect(error.message).toBe('文件超过 1KB 上限');
  });

  it('分片没标截断但落盘字节数超阈值 → 同样 413（stat 复核是第二道）', async () => {
    const error = await expectRejection([
      filePart({ chunk: Buffer.alloc(LIMITS.maxUploadBytes + 1, 7) }),
    ]);
    expect(error.httpStatus).toBe(413);
    expect(error.errorCode).toBe(ERROR_CODES.UPLOAD_TOO_LARGE);
  });

  it('字段值被截断单独报，而不是让后面的 JSON 解析去猜', async () => {
    const error = await expectRejection([field('project', '{"name":', true)]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('字段「project」内容过长，已被截断');
  });
});

describe('intakeUpload：字段白名单与文件个数', () => {
  it('白名单外的字段 → 400 点名是哪个', async () => {
    const error = await expectRejection([field('accessMode', 'public'), filePart()]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('不支持提交「accessMode」字段');
  });

  it('同名字段重复提交 → 400（后一个悄悄盖掉前一个才是真事故）', async () => {
    const error = await expectRejection([field('note', '第一版'), field('note', '第二版')]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('字段「note」重复提交');
  });

  it('文件字段名不是 file → 400', async () => {
    const error = await expectRejection([filePart({ fieldname: 'archive' })]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toContain('只接受「file」');
  });

  it('第二个文件分片 → 400 而不是把它当成超限', async () => {
    const error = await expectRejection([filePart(), filePart()]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('一次只能上传一个 zip 文件');
  });

  it('只有字段没有文件 → 400 缺少上传文件', async () => {
    const error = await expectRejection([field('note', 'x')]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toContain('缺少上传文件');
  });

  it('空文件名 → 400（source_name 是 not null）', async () => {
    const error = await expectRejection([filePart({ filename: '' })]);
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('文件名不能为空');
  });
});

/**
 * 解析器层限额（计划 M3-T2 实测发现的口子）：这类错误在 `parts()` 里就抛了，
 * 我们的循环看不到第二个文件分片。不翻译 → 异常过滤器按未知错误回 500，
 * 用户会对着一个必然失败的包反复重试。
 */
describe('intakeUpload：解析器层限额要翻译成人话，不能留 500', () => {
  it('files:1 命中第二个文件 → 400，且已写一半的文件被删掉', async () => {
    const error = await rejectionFromParser('FST_FILES_LIMIT', [filePart()]);
    expect(error.httpStatus).toBe(400);
    expect(error.errorCode).toBe(ERROR_CODES.PARAM_INVALID);
    expect(error.message).toBe('一次只能上传一个 zip 文件');
  });

  it('字段数超限 → 400 并说明上限', async () => {
    const error = await rejectionFromParser('FST_FIELDS_LIMIT');
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe(`表单字段过多（最多 ${MULTIPART_MAX_FIELDS} 个）`);
  });

  it('字段名撞 Object.prototype → 400', async () => {
    const error = await rejectionFromParser('FST_PROTO_VIOLATION');
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe('字段名不合法');
  });

  it('声明成 JSON 的字段解析失败 → 400 指出是 project/prototype', async () => {
    const error = await rejectionFromParser('FST_INVALID_JSON_FIELD_ERROR');
    expect(error.httpStatus).toBe(400);
    expect(error.message).toContain('不是合法 JSON');
    expect(error.message).toContain('project');
  });

  it('认不出的解析器错误原样抛出：把框架故障洗成 400 会藏住 bug', async () => {
    const { root, storage } = await harness();
    const thrown = await intakeUpload(
      requestWithParserError('FST_FILE_BUFFER_NOT_FOUND', [filePart()]),
      storage,
      LIMITS,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).not.toBeInstanceOf(BusinessException);
    expect((thrown as Error).message).toContain('FST_FILE_BUFFER_NOT_FOUND');
    expect(await readdir(join(root, TMP_PREFIX))).toEqual([]);
  });
});

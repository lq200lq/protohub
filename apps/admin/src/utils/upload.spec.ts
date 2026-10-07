import type { UploaderTaskState } from './upload';

import { DEFAULT_MAX_UPLOAD_BYTES, ERROR_CODES, UPLOAD_TASK_STAGES } from '@protohub/shared';
import { describe, expect, it } from 'vitest';

import {
  intakeFailureDataOf,
  UPLOAD_STAGE_ORDER,
  uploadStageLabelKey,
  uploadStepView,
  zipFileIssue,
} from './upload';

const MB = 1024 * 1024;

describe('zipFileIssue', () => {
  it('只收 .zip，且扩展名大小写无关', () => {
    expect(zipFileIssue({ name: 'a.zip', size: MB })).toBeNull();
    expect(zipFileIssue({ name: 'A.ZIP', size: MB })).toBeNull();
    expect(zipFileIssue({ name: 'a.rar', size: MB })).toBe('notZip');
    expect(zipFileIssue({ name: 'zip', size: MB })).toBe('notZip');
    // 改过扩展名的可执行文件不能因为"看起来像 zip"就进受理链路
    expect(zipFileIssue({ name: 'a.zip.exe', size: MB })).toBe('notZip');
  });

  it('空文件与超限分别报，扩展名先行', () => {
    expect(zipFileIssue({ name: 'a.zip', size: 0 })).toBe('empty');
    expect(zipFileIssue({ name: 'a.zip', size: DEFAULT_MAX_UPLOAD_BYTES })).toBeNull();
    expect(zipFileIssue({ name: 'a.zip', size: DEFAULT_MAX_UPLOAD_BYTES + 1 })).toBe(
      'tooLarge',
    );
    expect(zipFileIssue({ name: 'a.txt', size: 0 })).toBe('notZip');
  });

  it('阈值可配：MAX_UPLOAD_BYTES 改了以后界面预检跟着走', () => {
    expect(zipFileIssue({ name: 'a.zip', size: 2 * MB }, MB)).toBe('tooLarge');
    expect(zipFileIssue({ name: 'a.zip', size: MB }, MB)).toBeNull();
  });
});

describe('uploadStepView 服务端处理进度 → 步骤条', () => {
  const taskOf = (
    status: UploaderTaskState['status'],
    patch: Partial<UploaderTaskState> = {},
  ): UploaderTaskState => ({
    error: null,
    progress: 0,
    stage: null,
    status,
    ...patch,
  });

  it('四个阶段各自落在自己那一格，且都带 processing 文案', () => {
    UPLOAD_TASK_STAGES.forEach((stage, index) => {
      const view = uploadStepView(taskOf('processing', { progress: 55, stage }));
      expect(view.current).toBe(index);
      expect(view.status).toBe('process');
      expect(view.progress).toBe(55);
      expect(view.textKey).toBe('proto.uploader.processing');
      expect(view.textParams).toEqual([55]);
    });
  });

  it('还没被 Worker 取走（pending）与 stage 缺失都停在第一格，靠文案区分', () => {
    const queued = uploadStepView(taskOf('pending', { progress: 12 }));
    expect(queued).toMatchObject({
      current: 0,
      status: 'process',
      textKey: 'proto.uploader.queued',
      textParams: [],
    });
    const noStage = uploadStepView(taskOf('processing'));
    expect(noStage.current).toBe(0);
    expect(noStage.textKey).toBe('proto.uploader.processing');
    expect(queued.textKey).not.toBe(noStage.textKey);
  });

  it('成功判 finish、失败与取消判 error，都不再挤一行进度文案', () => {
    expect(uploadStepView(taskOf('success', { progress: 100, stage: 'committing' }))).toMatchObject(
      { current: 3, status: 'finish', textKey: null },
    );
    expect(uploadStepView(taskOf('failed', { stage: 'postprocess' })).status).toBe('error');
    expect(uploadStepView(taskOf('failed', { stage: 'postprocess' })).textKey).toBeNull();
    expect(uploadStepView(taskOf('canceled')).status).toBe('error');
  });

  it('步骤条的四格标签与 UPLOAD_STAGE_ORDER 同序，浮层用的单格键也在其中', () => {
    const labelKeys = uploadStepView(taskOf('pending')).labelKeys;
    expect(labelKeys).toEqual(UPLOAD_STAGE_ORDER.map(uploadStageLabelKey));
    expect(labelKeys).toEqual([
      'proto.uploader.stages.validating',
      'proto.uploader.stages.extracting',
      'proto.uploader.stages.postprocess',
      'proto.uploader.stages.committing',
    ]);
    // 键是字面量而不是模板拼：语言包里的键要能被静态检索到（前端设计 §11）
    expect(uploadStageLabelKey(null)).toBe('proto.uploader.stages.validating');
  });
});

describe('intakeFailureDataOf 受理阶段失败', () => {
  /**
   * 这一条钉的是实测踩到的坑：`requestClient` 失败时抛的是响应体本身，早先按
   * `error.response.data` 取值 → 稳定码静默丢成 null → 「强制发布」的出口整块不渲染，
   * 用户对着"内容与当前版本一致"点重试永远不会成功。
   */
  it('抛响应体本身时，稳定码与人话都原样抬出来', () => {
    expect(
      intakeFailureDataOf({
        code: -1,
        data: null,
        error: '内容与当前版本一致，未产生新版本',
        errorCode: ERROR_CODES.UPLOAD_DUPLICATE_CONTENT,
        message: 'duplicate',
      }),
    ).toEqual({
      errorCode: ERROR_CODES.UPLOAD_DUPLICATE_CONTENT,
      message: '内容与当前版本一致，未产生新版本',
    });
  });

  it('没走 requestClient 的请求（error.response.data）也认', () => {
    expect(
      intakeFailureDataOf({
        response: { data: { errorCode: 'UPLOAD_TOO_LARGE', message: '文件超过 100MB 上限' } },
      }),
    ).toEqual({ errorCode: 'UPLOAD_TOO_LARGE', message: '文件超过 100MB 上限' });
  });

  it('请求根本没发出去时不给稳定码、也不给句子——兜底话术由调用方补', () => {
    expect(intakeFailureDataOf(new Error('Network Error'))).toEqual({
      errorCode: null,
      message: '',
    });
    expect(intakeFailureDataOf(undefined)).toEqual({ errorCode: null, message: '' });
    expect(intakeFailureDataOf('boom')).toEqual({ errorCode: null, message: '' });
  });

  it('只有 errorCode 没有文案时仍然保留码：界面按码分岔，句子可以缺', () => {
    expect(
      intakeFailureDataOf({ errorCode: ERROR_CODES.PROTO_NOT_FOUND }),
    ).toEqual({ errorCode: ERROR_CODES.PROTO_NOT_FOUND, message: '' });
  });
});

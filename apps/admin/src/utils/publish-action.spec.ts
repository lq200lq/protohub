import type { PublishTaskRow } from '#/store';

import { ERROR_CODES, UPLOAD_TASK_STATUSES } from '@protohub/shared';
import { describe, expect, it } from 'vitest';

import { PUBLISH_ACTION_LABEL_KEYS, publishActionOf } from './publish-action';

/**
 * 主按钮判定的回归测试（迭代实施计划 §3.6：纯函数必须单测）。
 *
 * 这个函数是发布主按钮的唯一判定，所以这里钉的是那条底线：
 * 处理中不能再提交、成功后不再留提交口、目标被删不给「重试」。
 */
function rowOf(
  status: PublishTaskRow['status'],
  patch: Partial<PublishTaskRow> = {},
): PublishTaskRow {
  return {
    accessPath: null,
    accessUrl: null,
    error: null,
    file: new File(['zip'], 'prototype.zip', { type: 'application/zip' }),
    form: { projectId: '1', prototype: { name: '演示原型' } },
    id: 'row-1',
    notice: null,
    progress: 0,
    projectId: '1',
    prototypeId: '2',
    prototypeName: '演示原型',
    stage: null,
    status,
    taskId: '10',
    uploadPercent: 0,
    uploading: false,
    ...patch,
  };
}

describe('publishActionOf 初次提交', () => {
  it('还没有任务行时可以提交', () => {
    expect(publishActionOf(null)).toEqual({
      kind: 'publish',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: true,
    });
  });
});

describe('publishActionOf 五个服务端状态全覆盖', () => {
  /** 服务端新增状态时这张表会编译不过——判定不能靠"其余都落进默认分支"糊过去 */
  const expected: Record<PublishTaskRow['status'], 'done' | 'retry' | 'running'> = {
    canceled: 'retry',
    failed: 'retry',
    pending: 'running',
    processing: 'running',
    success: 'done',
  };

  it.each(UPLOAD_TASK_STATUSES)('%s → 该判成哪一种', (status) => {
    expect(publishActionOf(rowOf(status)).kind).toBe(expected[status]);
  });

  it('服务端状态枚举与表里的键一样多（防止漏填）', () => {
    expect(Object.keys(expected).sort()).toEqual([...UPLOAD_TASK_STATUSES].sort());
  });

  it('在跑与已完成都不给提交口，只有失败可重试', () => {
    expect(publishActionOf(rowOf('processing')).runnable).toBe(false);
    expect(publishActionOf(rowOf('success')).runnable).toBe(false);
    expect(publishActionOf(rowOf('failed')).runnable).toBe(true);
    expect(publishActionOf(rowOf('failed')).labelKey).toBe(PUBLISH_ACTION_LABEL_KEYS.retry);
  });

  it('浏览器还在上传那一段也算在跑，即使服务端状态仍是 pending', () => {
    const uploading = rowOf('pending', { progress: 0, uploadPercent: 37, uploading: true });
    expect(publishActionOf(uploading)).toEqual({
      kind: 'running',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: false,
    });
  });
});

describe('publishActionOf 失败要按稳定码分岔', () => {
  it('目标原型已被删除：判成 blocked，按钮文案还是「立即发布」而不是「重试」', () => {
    // DEV-18：重试这一行只会再撞一次同一个错，出路是另选目标，所以不给重试口
    const targetGone = { errorCode: ERROR_CODES.PROTO_NOT_FOUND, message: '原型已被删除' };
    const gone = rowOf('failed', { error: targetGone });
    expect(publishActionOf(gone)).toEqual({
      kind: 'blocked',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: false,
    });
    expect(publishActionOf(rowOf('canceled', { error: targetGone })).kind).toBe('blocked');
  });

  it('内容重复（要去勾「强制发布」）仍是可重试的一行', () => {
    const dup = rowOf('failed', {
      error: {
        errorCode: ERROR_CODES.UPLOAD_DUPLICATE_CONTENT,
        message: '内容与当前版本一致，未产生新版本',
      },
    });
    expect(publishActionOf(dup).kind).toBe('retry');
    expect(publishActionOf(dup).runnable).toBe(true);
  });

  it('没有稳定码的失败（请求根本没发出去）也归重试，不判成 blocked', () => {
    const noCode = rowOf('failed', { error: { errorCode: null, message: '网络中断' } });
    expect(publishActionOf(noCode).kind).toBe('retry');
    expect(publishActionOf(rowOf('failed', { error: null })).kind).toBe('retry');
  });

  it('成功行哪怕带着 accessUrl 也不给第二次提交口', () => {
    const done = rowOf('success', {
      accessPath: '/p/crm/crm-p01',
      accessUrl: 'http://127.0.0.1:3100/p/crm/crm-p01',
      progress: 100,
      stage: 'committing',
    });
    expect(publishActionOf(done)).toEqual({
      kind: 'done',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: false,
    });
  });
});

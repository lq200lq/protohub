import type { PublishTaskRow } from '#/store';

import { ERROR_CODES } from '@protohub/shared';

/**
 * 主按钮「立即发布 / 重试」在任务状态下的语义（前端设计 §3.4：处理中不给第二个提交口，
 * 失败时「立即发布」变「重试」）。
 *
 * 抽屉把它落到 `drawerApi.setState`（换底部按钮的文案与显隐）。判定收在这一处纯函数里，
 * 是为了让按钮语义跟着任务状态走、而不是跟着某个视图的局部状态走（迭代实施计划 §3.7
 * 「同类能力收敛一处」）——页面里再出现发布入口时直接复用，不重写一遍。
 *
 * 只回 i18n key 不回译好的句子——与 `utils/upload.ts` 同一口径，这个文件要能在没有 locale
 * provider 的 vitest 里被直接断言。
 */
export type PublishActionKind =
  | 'blocked'
  | 'done'
  | 'publish'
  | 'retry'
  | 'running';

export interface PublishAction {
  /** `done` = 这一行已成功，界面在结果态；`running` = 上传或服务端处理进行中 */
  kind: PublishActionKind;
  labelKey: string;
  /** 这一行值得再点一次主按钮（重试）；其余状态要么在跑、要么得先改输入 */
  runnable: boolean;
}

export const PUBLISH_ACTION_LABEL_KEYS = {
  publish: 'proto.publish.publishAction',
  retry: 'proto.common.retry',
} as const;

export function publishActionOf(row: null | PublishTaskRow): PublishAction {
  if (row === null) {
    return {
      kind: 'publish',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: true,
    };
  }
  if (row.status === 'canceled' || row.status === 'failed') {
    // 目标原型已被删除：重跑这一行只会再撞一次同一个错，出路是另选一个原型（机制 §3.2，
    // 计划 §9.2 DEV-18 明确要求这条不落进「重试」分支）
    if (row.error?.errorCode === ERROR_CODES.PROTO_NOT_FOUND) {
      return {
        kind: 'blocked',
        labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
        runnable: false,
      };
    }
    return {
      kind: 'retry',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.retry,
      runnable: true,
    };
  }
  if (row.status === 'success') {
    // 这一行已经交付完了：主按钮留着等于允许同一份包排出第二条任务
    return {
      kind: 'done',
      labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
      runnable: false,
    };
  }
  // 本地上传中，或已受理在等服务端（pending / processing）：都是"这一行还在跑"
  return {
    kind: 'running',
    labelKey: PUBLISH_ACTION_LABEL_KEYS.publish,
    runnable: false,
  };
}

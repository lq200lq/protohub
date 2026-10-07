import type {
  PageResult,
  ProjectEventItem,
  ReleaseAcceptedResult,
  ReleaseEventItem,
  ReleaseEventListQuery,
  ReleaseLinkPreviewResult,
  ReleaseListItem,
  ReleaseListQuery,
  ReleaseUploadForm,
  RollbackResult,
  UploadTaskStatus,
  UploadTaskStatusResult,
} from '@protohub/shared';

import { IDEMPOTENCY_KEY_HEADER } from '@protohub/shared';

import { requestClient } from '#/api/request';

/**
 * 发布与版本的接口层（后端接口设计 §5）。
 *
 * 轮询 `pollUploadTask` 放在这一层而不是组件里：抽屉和右下角浮层看的是同一个任务，
 * 两处各写一个 `setInterval` 就会出现"关掉抽屉后两份轮询打同一个任务、两份进度条互相打架"。
 */

/** §5.1 受理：唯一的 multipart 接口。域名字段按三选一组合提交，服务端自己判矛盾（矛盾一律 400）。 */
export function createReleaseApi(
  payload: ReleaseUploadForm,
  file: File,
  onProgress?: (percent: number) => void,
) {
  const note = payload.note?.trim() ?? '';
  return requestClient.upload<ReleaseAcceptedResult>(
    '/releases',
    {
      file,
      // 服务端 optionalQueryBoolean 认 'true'；不想要强制发布时干脆不提交这个字段
      force: payload.force === true ? 'true' : undefined,
      note: note === '' ? undefined : note,
      project: payload.project === undefined ? undefined : JSON.stringify(payload.project),
      projectId: payload.projectId,
      prototype:
        payload.prototype === undefined ? undefined : JSON.stringify(payload.prototype),
      prototypeId: payload.prototypeId,
    },
    {
      // §1.5 的幂等键：一次提交意图一个 UUID。失败后点「重试」是**新**意图，所以也换新键——
      // 复用旧键会被 10 分钟窗口内的重放逻辑直接送回那条已失败的task，用户看到的是"重试完还是失败"。
      headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
      onUploadProgress: (event: { loaded: number; total?: number }) => {
        const total = event.total ?? 0;
        onProgress?.(total > 0 ? Math.round((event.loaded / total) * 100) : 0);
      },
      // 默认 10 秒超时对 100MB 包必然失败（前端设计 §8）：进度与取消由调用方负责。
      timeout: 0,
    },
  );
}

/** GET /api/releases/link-preview（§5.9）：完整 URL 由服务端拼装，前端不各写一遍域名 */
export function getReleaseLinkPreviewApi(projectCode: string, prototypeCode: string) {
  return requestClient.get<ReleaseLinkPreviewResult>('/releases/link-preview', {
    params: { projectCode, prototypeCode },
  });
}

/** GET /api/upload-tasks/{id}（§5.3） */
export function getUploadTaskStatusApi(taskId: string) {
  return requestClient.get<UploadTaskStatusResult>(`/upload-tasks/${taskId}`);
}

const UPLOAD_POLL_INTERVAL_MS = 1000;
const UPLOAD_POLL_MAX_TRIES = 120;

/** 终态：到了这里就不用再问（§5.3 的轮询出口） */
export function isFinalUploadTaskStatus(status: UploadTaskStatus): boolean {
  return status === 'canceled' || status === 'failed' || status === 'success';
}

export interface PollUploadTaskOptions {
  intervalMs?: number;
  maxTries?: number;
  /** 每次拿到任务都回调一次，调用方据此刷新进度（组件自己不持有定时器） */
  onTick?: (task: UploadTaskStatusResult) => void;
  /** 放弃等待（比如用户把浮层上的任务划掉）：停止轮询但不动服务端 */
  signal?: AbortSignal;
}

/**
 * §5.3 轮询的唯一实现：1s 一次、最多 120 次。
 *
 * 次数用尽时返回最后一次的非终态任务而不是抛错——任务还在服务端跑，这不是失败，
 * 界面要给的是一条出口（"处理时间较长，请稍后在原型详情查看结果"），由调用方判 `status` 决定文案。
 */
export async function pollUploadTask(
  taskId: string,
  options: PollUploadTaskOptions = {},
): Promise<UploadTaskStatusResult> {
  const intervalMs = options.intervalMs ?? UPLOAD_POLL_INTERVAL_MS;
  const maxTries = Math.max(1, options.maxTries ?? UPLOAD_POLL_MAX_TRIES);
  let task = await getUploadTaskStatusApi(taskId);
  options.onTick?.(task);
  for (let index = 1; index < maxTries; index += 1) {
    if (isFinalUploadTaskStatus(task.status) || options.signal?.aborted) {
      break;
    }
    await delay(intervalMs);
    if (options.signal?.aborted) {
      break;
    }
    task = await getUploadTaskStatusApi(taskId);
    options.onTick?.(task);
  }
  return task;
}

/** GET /api/prototypes/{id}/releases（§5.4） */
export function getReleasesApi(prototypeId: string, params: ReleaseListQuery) {
  return requestClient.get<PageResult<ReleaseListItem>>(
    `/prototypes/${prototypeId}/releases`,
    { params },
  );
}

/** POST /api/prototypes/{id}/rollback（§5.5）：回滚后的原型详情 */
export function rollbackReleaseApi(
  prototypeId: string,
  releaseId: string,
  reason?: string,
) {
  const text = reason?.trim() ?? '';
  return requestClient.post<RollbackResult>(
    `/prototypes/${prototypeId}/rollback`,
    { releaseId, reason: text === '' ? undefined : text },
  );
}

/** DELETE /api/prototypes/{id}/releases/{releaseId}（§5.6）：当前生效版本会被 400 拒掉 */
export function deleteReleaseApi(prototypeId: string, releaseId: string) {
  return requestClient.delete<void>(
    `/prototypes/${prototypeId}/releases/${releaseId}`,
  );
}

/** GET /api/prototypes/{id}/events（§5.8） */
export function getReleaseEventsApi(prototypeId: string, params: ReleaseEventListQuery) {
  return requestClient.get<PageResult<ReleaseEventItem>>(
    `/prototypes/${prototypeId}/events`,
    { params },
  );
}

/** GET /api/projects/{id}/events（§5.8 末段：项目级动态，字段多 prototypeName/prototypeCode） */
export function getProjectEventsApi(projectId: string, params: ReleaseEventListQuery) {
  return requestClient.get<PageResult<ProjectEventItem>>(
    `/projects/${projectId}/events`,
    { params },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

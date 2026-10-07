import type { UploadTaskStage, UploadTaskStatus } from '@protohub/shared';

import { DEFAULT_MAX_UPLOAD_BYTES } from '@protohub/shared';

/**
 * 上传文件的本地预检（前端设计 §3.4 状态机的 `idle → 本地校验` 那一格）。
 *
 * 只做"一眼看得出来"的三种判定：扩展名、空文件、超限。包内容（是不是真 zip、有没有
 * `index.html`、路径合不合法）一律留给服务端 §2.2 的轻校验——浏览器这里既不可靠也不安全。
 * 阈值与受理阶段的判定读同一个 shared 常量，界面文案不会说一个、服务端按另一个拒。
 */
export type UploadLocalIssue = 'empty' | 'notZip' | 'tooLarge';

export function zipFileIssue(
  file: { name: string; size: number },
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): null | UploadLocalIssue {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return 'notZip';
  }
  if (file.size === 0) {
    return 'empty';
  }
  if (file.size > maxBytes) {
    return 'tooLarge';
  }
  return null;
}

/**
 * 失败详情。`message` 一律是服务端给的那句人话（机制 §8.2：界面直接读，不再在前端重算文案）；
 * `errorCode` 在本地失败（请求根本没发出去、受理阶段的 4xx 没有任务码）时可以缺席，
 * 界面就只显示句子，不编一个不存在的稳定码。
 */
export interface UploaderFailure {
  errorCode: null | string;
  message: string;
}

/**
 * 受理阶段（`POST /releases`）抛出的东西 → §5.3 的失败形状。
 *
 * 稳定码不能丢：`UPLOAD_DUPLICATE_CONTENT` 的出路是勾「强制发布」重发，目标原型被删则只能另选目标，
 * 这些都按码判定（`PublishTaskPanel`）。丢码不等于退回一句通用文案，而是把用户关进死胡同——
 * 同一句文案点「重试」永远不会成功。
 *
 * 两种形状都要认：`requestClient` 失败时抛的是响应体本身（见 `utils/error.ts`），而 `error.response.data`
 * 只出现在没走它的请求上。服务端一句话都没给时 `message` 留空字符串，由调用方补本地兜底话术
 * （这里不碰 i18n，与整个 `utils/upload.ts` 同一口径），也不编一个不存在的服务端码。
 */
export function intakeFailureDataOf(error: unknown): UploaderFailure {
  const thrown = error as
    | {
        error?: string;
        errorCode?: string;
        message?: string;
        response?: { data?: { error?: string; errorCode?: string; message?: string } };
      }
    | undefined;
  const data =
    thrown?.response?.data ??
    (typeof thrown?.errorCode === 'string' ? thrown : undefined);
  return {
    errorCode: data?.errorCode ?? null,
    message: data?.error ?? data?.message ?? '',
  };
}

/**
 * 上传器与浮层需要的最小任务视图（§5.3 响应里与进度呈现相关的那四个字段）。
 *
 * 单独收成一个类型有两个用处：① 抽屉传的是 store 里的任务行、浮层传的也是它，而发布成功态
 * 手里可能只有 §5.3 的原始响应，三者都能塞进同一个组件；② 组件不依赖整份响应，
 * 服务端加字段不会让上传器跟着变。
 */
export interface UploaderTaskState {
  error: null | UploaderFailure;
  progress: number;
  stage: null | UploadTaskStage;
  status: UploadTaskStatus;
}

/** §2.1 的四个处理阶段，顺序就是步骤条的顺序（也是服务端 stage 的推进顺序） */
export const UPLOAD_STAGE_ORDER: readonly UploadTaskStage[] = [
  'validating',
  'extracting',
  'postprocess',
  'committing',
];

/**
 * 键写成字面量而不是模板拼：语言包里的键要能被静态检索到（前端设计 §11）。
 * 这里只交键、不交译文，`utils` 层因此不必依赖 i18n（仓库根的 vitest 也没有 `#/` 别名）。
 */
const STAGE_LABEL_KEYS: Record<UploadTaskStage, string> = {
  committing: 'proto.uploader.stages.committing',
  extracting: 'proto.uploader.stages.extracting',
  postprocess: 'proto.uploader.stages.postprocess',
  validating: 'proto.uploader.stages.validating',
};

/** 浮层那种放不下整条步骤条的地方，只要"当前在做什么"这一段 */
export function uploadStageLabelKey(stage: null | UploadTaskStage): string {
  return STAGE_LABEL_KEYS[stage ?? 'validating'];
}

/**
 * 服务端处理进度 → 步骤条该画成什么样（前端设计 §3.4「两段进度分开呈现」的第二段）。
 *
 * 抽屉里的上传器和右下角的浮层都要显示这一条，所以判算收敛在这里一处：
 * `pending`（还没被 Worker 取走）与 `stage=null` 都停在第一格、靠文案区分而不是多造一步；
 * 失败/取消把整条判成 error，成功判成 finish。
 */
export interface UploadStepView {
  /** antd `Steps` 的 current（0 起） */
  current: number;
  /** 与 UPLOAD_STAGE_ORDER 同序的语言包键 */
  labelKeys: string[];
  progress: number;
  status: 'error' | 'finish' | 'process';
  /** 步骤条下那行人话的键；null 表示没有额外文案可说（成功与失败各有自己的区块） */
  textKey: null | string;
  textParams: (number | string)[];
}

export function uploadStepView(task: UploaderTaskState): UploadStepView {
  const labelKeys = UPLOAD_STAGE_ORDER.map((item) => STAGE_LABEL_KEYS[item]);
  const status: UploadStepView['status'] =
    task.status === 'canceled' || task.status === 'failed'
      ? 'error'
      : task.status === 'success'
        ? 'finish'
        : 'process';
  if (task.status === 'pending') {
    return {
      current: 0,
      labelKeys,
      progress: task.progress,
      status,
      textKey: 'proto.uploader.queued',
      textParams: [],
    };
  }
  return {
    current: UPLOAD_STAGE_ORDER.indexOf(task.stage ?? 'validating'),
    labelKeys,
    progress: task.progress,
    status,
    textKey:
      status === 'process' && task.status === 'processing'
        ? 'proto.uploader.processing'
        : null,
    textParams: [task.progress],
  };
}



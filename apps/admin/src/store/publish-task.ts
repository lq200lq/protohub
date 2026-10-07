import type {
  ReleaseAcceptedResult,
  ReleaseUploadForm,
  UploadTaskStatusResult,
} from '@protohub/shared';

import { computed, h, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, notification } from 'ant-design-vue';
import { defineStore } from 'pinia';

import {
  createReleaseApi,
  isFinalUploadTaskStatus,
  pollUploadTask,
} from '#/api';
import { $t } from '#/locales';
import { toErrorMessage } from '#/utils/error';
import { intakeFailureDataOf } from '#/utils/upload';
import type { UploaderFailure, UploaderTaskState } from '#/utils/upload';

/**
 * 发布任务 store（前端设计 §7 里唯一新增的业务 store）。
 *
 * 为什么要有它：一次发布要跑两三分钟（上传 → 受理 → 解压 → 改写 → 切版本），而设计要求
 * "关闭抽屉不阻止任务、关掉后在右下角浮层继续看到结果"。任务状态若长在抽屉里，抽屉一关就没了；
 * 若各页面自己轮，同一个任务就有两份进度条。所以状态与那份唯一的轮询都收在这里，
 * 抽屉与浮层只是同一行数据的两个视图。
 */

/**
 * 一行任务 = §5.3 里与进度呈现相关的四个字段（`UploaderTaskState`，上传器直接吃它）
 * + 界面还要用的身份信息、本地上传这一段、以及几个出口。
 *
 * `status` 在受理成功前是 `pending`——那还没有服务端任务可问，此时界面上盖着的是
 * `uploading` 这一段（浏览器 → 服务端），不会把"排队中"错显示出来。
 */
export interface PublishTaskRow extends UploaderTaskState {
  /** 发布成功后的完整链接（§5.3 `release.accessUrl`，域名由服务端拼）；受理阶段只有相对路径 */
  accessPath: null | string;
  accessUrl: null | string;
  /** 提交出去的包：失败重试要复用同一个文件，不让用户重选一遍 */
  file: File;
  /** 受理时提交的域字段（三选一的那一套），重试沿用 */
  form: ReleaseUploadForm;
  id: string;
  /** 浮层与通知的标题：受理前只能靠表单里的名字 */
  prototypeName: string;
  projectId: null | string;
  prototypeId: null | string;
  /** 查询任务这件事本身进行不下去了（等满 120 次、或轮询请求失败）：给出口，不改判服务端 */
  notice: null | string;
  taskId: null | string;
  uploadPercent: number;
  uploading: boolean;
}

export interface PublishTaskDraft {
  file: File;
  form: ReleaseUploadForm;
  prototypeName: string;
}

/**
 * 受理阶段的失败：判定在 `utils/upload.ts`（纯函数、可单测），这里只补没有服务端文案时的本地兜底。
 */
function intakeFailureOf(error: unknown): UploaderFailure {
  const data = intakeFailureDataOf(error);
  return {
    errorCode: data.errorCode,
    message:
      data.message === ''
        ? toErrorMessage(error) || $t('proto.publish.intakeFailed')
        : data.message,
  };
}

export const usePublishTaskStore = defineStore('publish-task', () => {
  const router = useRouter();
  const tasks = ref<PublishTaskRow[]>([]);
  /**
   * 抽屉正在显示的那一条。浮层跳过它，否则同一个任务会同时出现在抽屉和右下角——
   * 两份进度条、两个步骤条，用户看不出哪个是真的。
   */
  const heldId = ref<null | string>(null);
  /** 每条任务自己的中止器：用户把浮层上那行划掉时停止轮询（服务端任务不受影响） */
  const waitControllers = new Map<string, AbortController>();

  const floatTasks = computed(() =>
    tasks.value.filter((task) => task.id !== heldId.value),
  );

  function taskOf(id: null | string): null | PublishTaskRow {
    if (id === null) {
      return null;
    }
    return tasks.value.find((task) => task.id === id) ?? null;
  }

  /**
   * 只经 `tasks` 里的响应式代理写状态。
   *
   * 行被用户划掉之后就找不到代理了：此时静默返回，正在跑的轮询循环会因为 AbortController
   * 一起结束，不该再往已经不存在的行上写。
   */
  function patch(id: string, changes: Partial<PublishTaskRow>): void {
    const row = tasks.value.find((task) => task.id === id);
    if (!row) {
      return;
    }
    Object.assign(row, changes);
  }

  /** 抽屉打开/关闭时声明所有权：`hold(id)` 交给抽屉显示，`hold(null)` 交还浮层 */
  function hold(id: null | string): void {
    heldId.value = id;
  }

  /**
   * 发起一次发布：立即返回行 id，上传与轮询在后台跑。
   *
   * 调用方（抽屉的「立即发布」按钮）等的是 id 而不是结果——结果要两三分钟才出来，
   * 把按钮 loading 挂在这个 Promise 上就等于把用户锁在抽屉里等（§3.4 明确不做）。
   */
  function submit(draft: PublishTaskDraft): string {
    const id = crypto.randomUUID();
    tasks.value.push({
      accessPath: null,
      accessUrl: null,
      error: null,
      file: draft.file,
      form: draft.form,
      id,
      notice: null,
      progress: 0,
      prototypeId: draft.form.prototypeId ?? null,
      prototypeName: draft.prototypeName,
      projectId: draft.form.projectId ?? null,
      stage: null,
      status: 'pending',
      taskId: null,
      uploadPercent: 0,
      uploading: true,
    });
    heldId.value = id;
    void run(id);
    return id;
  }

  /**
   * 重试：复用同一行、同一个包，不重填表单（§3.4）。
   *
   * 受理阶段已经落库过 draft 原型（接口设计 §5.1 的理由），所以拿到过 prototypeId 的行
   * 只发 `{ prototypeId, note }`——再发一遍 project/prototype 会撞上服务端的三选一矛盾判定。
   * 幂等键每次都是新的（`createReleaseApi` 内部生成）：复用旧键会被 10 分钟窗口里的重放
   * 逻辑送回那条已失败的任务，用户看到的是"重试完还是失败"。
   *
   * `force` 是给 `UPLOAD_DUPLICATE_CONTENT` 用的出口（接口设计 §8：界面勾选「强制发布」后重发）。
   */
  function retry(id: string, options: { force?: boolean } = {}): void {
    const row = taskOf(id);
    if (!row) {
      return;
    }
    const force = options.force === true;
    if (row.prototypeId !== null) {
      patch(id, {
        form: { force, note: row.form.note, prototypeId: row.prototypeId },
        projectId: row.projectId,
      });
    } else {
      patch(id, { form: { ...row.form, force } });
    }
    void run(id);
  }

  /** 等满 120 次之后由界面给的「继续等待」出口：接着轮同一个任务 */
  function resumeWaiting(id: string): void {
    const row = taskOf(id);
    if (!row || row.taskId === null || isFinalUploadTaskStatus(row.status)) {
      return;
    }
    patch(id, { notice: null });
    void waitForTask(id, row.taskId);
  }

  /**
   * 划掉这一行：停止轮询并把它从界面拿走。
   *
   * 刻意不调服务端的取消接口——任务在服务端会继续跑完并落库，链接照样能用；
   * 用户取消的是"我看着"，不是"这次发布"。§5.3 也没有给出取消任务的接口。
   */
  function dismiss(id: string): void {
    waitControllers.get(id)?.abort();
    waitControllers.delete(id);
    tasks.value = tasks.value.filter((task) => task.id !== id);
    if (heldId.value === id) {
      heldId.value = null;
    }
  }

  async function run(id: string): Promise<void> {
    const row = taskOf(id);
    if (!row) {
      return;
    }
    patch(id, {
      error: null,
      notice: null,
      progress: 0,
      stage: null,
      status: 'pending',
      taskId: null,
      uploadPercent: 0,
      uploading: true,
    });

    let accepted: ReleaseAcceptedResult;
    try {
      accepted = await createReleaseApi(row.form, row.file, (percent) => {
        patch(id, { uploadPercent: percent });
      });
    } catch (error) {
      patch(id, {
        error: intakeFailureOf(error),
        status: 'failed',
        uploading: false,
      });
      return;
    }

    patch(id, {
      accessPath: accepted.accessPath,
      projectId: accepted.projectId,
      prototypeId: accepted.prototypeId,
      status: 'pending',
      taskId: accepted.taskId,
      uploading: false,
    });
    await waitForTask(id, accepted.taskId);
  }

  async function waitForTask(id: string, taskId: string): Promise<void> {
    const controller = new AbortController();
    waitControllers.set(id, controller);
    try {
      await pollUploadTask(taskId, {
        onTick: (task) => applyTask(id, task),
        signal: controller.signal,
      });
    } catch (error) {
      // 轮询请求本身失败：不改判服务端，只把"等不下去了"说清楚，并留下详情这一出口
      if (!controller.signal.aborted) {
        patch(id, { notice: toErrorMessage(error) || $t('proto.publish.waitFailed') });
      }
      waitControllers.delete(id);
      return;
    }
    waitControllers.delete(id);
    if (controller.signal.aborted) {
      return;
    }
    // 轮询返回时行可能已被划掉；到终态就不用再提示了
    const row = taskOf(id);
    if (row === null || isFinalUploadTaskStatus(row.status)) {
      return;
    }
    patch(id, { notice: $t('proto.publish.waitTimedOut') });
  }

  function applyTask(id: string, task: UploadTaskStatusResult): void {
    const release = task.release;
    patch(id, {
      // release 只在成功时给（§5.3）；中途不能把受理阶段拿到的 accessPath 抹成 null
      ...(release === null
        ? {}
        : { accessPath: release.accessPath, accessUrl: release.accessUrl }),
      error:
        task.error === null
          ? null
          : { errorCode: task.error.errorCode, message: task.error.message },
      progress: task.progress,
      stage: task.stage,
      status: task.status,
    });
    if (isFinalUploadTaskStatus(task.status)) {
      notifyResult(id, task);
    }
  }

  /**
   * §7 要求终态给通知。这里再叠一条设计要求里没有的：通知会自动消失（默认 4.5 秒），
   * 而成功态最重要的产出是那条访问链接——所以这一行不随终态清出，留在浮层上直到用户
   * 自己划掉（迭代实施计划 §9.2 DEV-21）。
   */
  function notifyResult(id: string, task: UploadTaskStatusResult): void {
    const row = taskOf(id);
    const label = row?.prototypeName ?? '';
    const prototypeId = row?.prototypeId ?? null;
    if (task.status === 'success') {
      notification.success({
        btn:
          prototypeId === null
            ? undefined
            : h(
                Button,
                {
                  onClick: () => {
                  // 不主动关掉通知：antdv 的 destroy 类型上没有 key 参数，而这条会在几秒后自己消失，
                  // 用户点按钮要的是跳到原型详情，不是把右下角那条留在原地
                  void goPrototypeDetail(prototypeId);
                },
                  size: 'small',
                  type: 'link',
                },
                () => $t('proto.publish.viewDetail'),
              ),
        description:
          task.release === null ? label : `${label} · ${task.release.accessUrl}`,
        key: id,
        message: $t('proto.publish.published'),
      });
      return;
    }
    if (task.status === 'failed') {
      notification.error({
        description: task.error?.message ?? label,
        key: id,
        message: $t('proto.publish.publishFailed'),
      });
    }
  }

  async function goPrototypeDetail(prototypeId: null | string): Promise<void> {
    if (prototypeId === null) {
      return;
    }
    await router.push({
      path: '/proto/prototype/detail',
      query: { id: prototypeId },
    });
  }

  return {
    dismiss,
    floatTasks,
    goPrototypeDetail,
    heldId,
    hold,
    resumeWaiting,
    retry,
    submit,
    taskOf,
    tasks,
  };
});

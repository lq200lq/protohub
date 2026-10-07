import { UPLOAD_TASK_STAGES, type UploadTaskStage } from '@protohub/shared';

/**
 * 进度回填的区间表（原型发布与访问机制 §2.1）。
 *
 * 阶段与区间只有这一处定义：Worker 写库、任务查询接口回显、前端画步骤条都读它，
 * 免得"extracting 到 60"这个数字散落在三个地方各写一遍（§3.7 通用能力收敛一处）。
 */
export const STAGE_BANDS: Readonly<Record<UploadTaskStage, readonly [number, number]>> = {
  committing: [90, 100],
  extracting: [10, 60],
  postprocess: [60, 90],
  validating: [0, 10],
};

/** 阶段顺序（也是前端步骤条的顺序）；来自 shared 的枚举，不在这儿重排。 */
export const STAGE_ORDER: readonly UploadTaskStage[] = UPLOAD_TASK_STAGES;

/** 进入某阶段时的进度：就是上一阶段的终点，所以直接取区间下界。 */
export function stageStartProgress(stage: UploadTaskStage): number {
  return STAGE_BANDS[stage][0];
}

/**
 * 把"阶段内完成度 0-1"换算成绝对进度。
 *
 * 解压是按字节推进的（§2.1 明确写了"按已处理字节比例"），而字节数会因为压缩率、
 * 条目数在 0 与 1 之间抖，所以这里夹到区间内并取整；越界的比例不报错——
 * 进度条不是账本，为一个浮点误差把发布判成失败是本末倒置。
 */
export function stageProgress(stage: UploadTaskStage, ratio: number): number {
  const [from, to] = STAGE_BANDS[stage];
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  return Math.round(from + (to - from) * clamped);
}

/** 阶段走完时的进度（区间上界）。 */
export function stageEndProgress(stage: UploadTaskStage): number {
  return STAGE_BANDS[stage][1];
}

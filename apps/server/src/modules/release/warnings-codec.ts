import type { Prisma } from '@prisma/client';
import type { UploadTaskWarning } from '@protohub/shared';

import { isUploadWarningCode } from '@protohub/shared';

/**
 * 发布告警的 jsonb 读写（机制 §2.7）。
 *
 * 同一份告警在两处落库：`proto_upload_task.warnings`（处理过程看到的）与
 * `proto_release.manifest.warnings`（这一版的发布报告）。两处读法必须一致，
 * 否则会出现"任务里说改写了 12 处、版本报告里同一条被判定成非法丢掉"这种自相矛盾。
 *
 * 读侧一律宽松：认不出的 code、缺 message 的条目直接跳过而不是抛——一条坏数据不该让
 * 整页版本列表打不开（列表里的计数与报告本来就是补充信息）。
 */
export function toWarnings(value: Prisma.JsonValue): readonly UploadTaskWarning[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return [];
    }
    const record = item as Record<string, unknown>;
    const { code, count, message } = record;
    if (
      typeof code !== 'string' ||
      !isUploadWarningCode(code) ||
      typeof message !== 'string'
    ) {
      return [];
    }
    return [
      {
        code,
        // 计数只认非负整数：负数与小数都是坏数据（同 version.repo.ts 的 toCount），
        // 去掉 count 而不是丢掉整条告警——消息本身已经把发生了什么说清楚了。
        ...(typeof count === 'number' && Number.isInteger(count) && count >= 0
          ? { count }
          : {}),
        message,
      },
    ];
  });
}

export function warningsToJson(
  warnings: readonly UploadTaskWarning[],
): Prisma.InputJsonValue {
  return warnings.map((warning) => ({ ...warning }));
}

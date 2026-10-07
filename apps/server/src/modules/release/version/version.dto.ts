import { z } from 'zod';

import { idStringField } from '../../system/common/dto';

/**
 * §5.5 回滚的请求契约。
 *
 * `releaseId` 的**形状**在这里判（十进制字符串，§1.1 的 bigint→string 约定），
 * 它的**归属与状态**（属于该原型、`status='ready'`、不是当前版本）一律在 `VersionRepo.rollback`
 * 的那把行锁里判——那需要事务内的快照，在服务层先读一遍再进事务等于拿过期数据做决定（§3.7 一处真相）。
 */
const reasonField = z.preprocess(
  (value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : value;
    return text === '' ? undefined : text;
  },
  z.string().max(300, '回滚原因最长 300 个字符').optional(),
);

export const rollbackSchema = z
  .object({
    reason: reasonField,
    releaseId: idStringField('版本 id'),
  })
  .strict();

export type RollbackInput = z.infer<typeof rollbackSchema>;

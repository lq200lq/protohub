import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * 文件 sha256 的唯一实现处（机制 §2.7 的两类指纹共用同一个口径）。
 *
 * 两个消费者：Worker 给**原始 zip** 算 `source_hash`（去重依据），postprocess 给**改写后的产物**
 * 逐文件算 `manifest.files[].sha256`（内容指纹依据）。两处都是同一个"流式读、hex 摘要"，
 * 所以只写一遍（§3.7 通用能力收敛一处）。
 *
 * 流式而不是 `readFile`：上限是 500MB 解压总量 / 100MB 原始包，装进内存会把 Worker 自己撑爆。
 */
export function sha256OfFile(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  return pipeline(createReadStream(absPath), hash).then(() => hash.digest('hex'));
}

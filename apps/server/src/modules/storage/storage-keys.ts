/**
 * 存储 key 规范（原型发布与访问机制 §1.2）。
 *
 * key 一律是**相对 STORAGE_ROOT、用 `/` 分隔、不带前导斜杠**的字符串，
 * 由这里的函数唯一拼装，业务代码不再手写 `releases/${...}` 之类的模板（§3.7 禁止路径硬编码）。
 *
 * 目录名用 ID 而不是编码/版本号（决策 D-09/D-14 的理由见 §1.2）：
 * ID 全局单调唯一、永不复用，编码将来若允许改名也不会让目录漂移。
 */

/** 版本产物根前缀，同时是 nginx `X-Proto-Release-Dir` 的取值形态。 */
export const RELEASES_PREFIX = 'releases';
export const TMP_PREFIX = 'tmp';
export const MANIFESTS_PREFIX = 'manifests';
export const TRASH_PREFIX = 'trash';

/** ID 只可能是 BigInt 的十进制字符串；任何别的内容都可能是路径注入，直接拒绝。 */
function idSegment(label: string, value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`存储 key 的 ${label} 必须是十进制 ID，收到 "${value}"`);
  }
  return value;
}

/** 随机后缀只允许字母数字（用于 tmp/trash 里避免并发撞名）。 */
function randomSegment(value: string): string {
  if (!/^[0-9a-z]{4,32}$/.test(value)) {
    throw new Error(`存储 key 的随机后缀必须是 4-32 位小写字母数字，收到 "${value}"`);
  }
  return value;
}

/** `releases/{projectId}/{prototypeId}/{releaseId}` —— 该版本产物的站点根，发布后不可变。 */
export function releaseKey(
  projectId: string,
  prototypeId: string,
  releaseId: string,
): string {
  return [
    RELEASES_PREFIX,
    idSegment('projectId', projectId),
    idSegment('prototypeId', prototypeId),
    idSegment('releaseId', releaseId),
  ].join('/');
}

/** 版本目录内某个产物文件。 */
export function releaseFileKey(
  projectId: string,
  prototypeId: string,
  releaseId: string,
  relativePath: string,
): string {
  const inner = relativeFilePath(relativePath);
  return `${releaseKey(projectId, prototypeId, releaseId)}/${inner}`;
}

/** 上传的原始 zip 落盘位置：`tmp/upload-{taskId}-{random}.zip`。 */
export function uploadTempKey(taskId: string, random: string): string {
  return `${TMP_PREFIX}/upload-${idSegment('taskId', taskId)}-${randomSegment(random)}.zip`;
}

/**
 * 受理中的过渡名：`tmp/upload-pending-{random}.zip`。
 *
 * §1.2 的正式名要带 `taskId`，而文件必须在**任何库记录之前**落盘（流式写盘没法预知自增 ID），
 * 所以先写这个过渡名，受理事务提交后再 rename 成 `uploadTempKey()`。选"没被任何记录引用的
 * 过渡文件"作为最坏情况，正是机制 §3.1「优先选可自愈的故障模式」的同一条理由（GC 能回收，
 * 用户看不见）。见计划 §9 DEV-17。
 */
export function uploadPendingKey(random: string): string {
  return `${TMP_PREFIX}/upload-pending-${randomSegment(random)}.zip`;
}

/** 解压工作目录：`tmp/work-{taskId}`，处理完成后 rename 进 releases 或被 GC 清掉。 */
export function workDirKey(taskId: string): string {
  return `${TMP_PREFIX}/work-${idSegment('taskId', taskId)}`;
}

/** 清单副本：`manifests/{prototypeId}/{releaseId}.json`，刻意在版本目录之外（等于不对外公开）。 */
export function manifestKey(prototypeId: string, releaseId: string): string {
  return `${MANIFESTS_PREFIX}/${idSegment('prototypeId', prototypeId)}/${idSegment('releaseId', releaseId)}.json`;
}

/** 延迟删除区：`trash/{yyyyMMdd}/{prototypeId}-{releaseId}-{random}`。 */
export function trashKey(
  dateDir: string,
  prototypeId: string,
  releaseId: string,
  random: string,
): string {
  if (!/^\d{8}$/.test(dateDir)) {
    throw new Error(`trash 目录日期段必须是 yyyyMMdd，收到 "${dateDir}"`);
  }
  return [
    TRASH_PREFIX,
    dateDir,
    `${idSegment('prototypeId', prototypeId)}-${idSegment('releaseId', releaseId)}-${randomSegment(random)}`,
  ].join('/');
}

/** 任意被移入 trash 的前缀都可以用这个形态（GC 里也用来收纳孤儿目录）。 */
export function trashKeyOf(dateDir: string, name: string, random: string): string {
  if (!/^\d{8}$/.test(dateDir)) {
    throw new Error(`trash 目录日期段必须是 yyyyMMdd，收到 "${dateDir}"`);
  }
  if (!/^[0-9a-z][0-9a-z_-]{0,99}$/i.test(name)) {
    throw new Error(`trash 收纳名只允许字母数字、下划线与短横线，收到 "${name}"`);
  }
  return `${TRASH_PREFIX}/${dateDir}/${name}-${randomSegment(random)}`;
}

/** `yyyyMMdd`，trash 按天分目录用（GC 的 TTL 判定也按这个日期段核算）。 */
export function dateDirOf(at: Date = new Date()): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  return `${String(yyyy)}${mm}${dd}`;
}

/** 产物内部的相对路径：与 §2.3 的 Zip Slip 初查同口径，这里再断言一次。 */
function relativeFilePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (
    normalized === '' ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..' || segment === '') ||
    normalized.length > 1024
  ) {
    throw new Error(`产物内路径不合法："${value}"`);
  }
  return normalized;
}

/** 从 `releases/{pid}/{protoId}/{rid}` 反解出三段 ID（GC 的孤儿目录检测要用）。 */
export function parseReleaseKey(
  key: string,
): { projectId: string; prototypeId: string; releaseId: string } | null {
  const matched = new RegExp(
    `^${RELEASES_PREFIX}/(\\d+)/(\\d+)/(\\d+)$`,
  ).exec(key);
  if (!matched) {
    return null;
  }
  return {
    projectId: matched[1] ?? '',
    prototypeId: matched[2] ?? '',
    releaseId: matched[3] ?? '',
  };
}

/**
 * 存储抽象接口（决策 D-08，原型发布与访问机制 §1.1）。
 *
 * v1 只有 `LocalStorageAdapter` 一个实现；S3 实现刻意**不实现**，但接口要留好降级路径：
 * 届时 `localPathOf()` 返回 `null`，"nginx 直出"退化为"Node 代理流式返回"，业务代码不变（§1.1）。
 *
 * key 的形态由 `storage-keys.ts` 唯一拼装，见 §1.2。
 */
export interface StorageAdapter {
  /** 把本地文件放到指定 key（上传/落盘） */
  putFile(localPath: string, key: string): Promise<void>;
  /** 读取对象（本地实现返回 createReadStream；S3 实现返回 HTTP 流的 Promise） */
  getStream(key: string): Promise<NodeJS.ReadableStream>;
  /** 递归删除一个前缀（GC 用） */
  deletePrefix(keyPrefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * 列出某个前缀下的**直接子项**（GC 的三处扫描共用这一个入口：trash 到期、tmp 残留、
   * `releases/{项目}/{原型}` 下的孤儿目录）。前缀不存在 = 空数组，不抛错——
   * GC 每一步都要能"基于当前状态推导"，第一次跑在空盘上就该是 no-op 而不是失败。
   */
  listPrefix(keyPrefix: string): Promise<StorageEntry[]>;
  /** 把某个前缀原子地移出服务范围（本地实现 = rename 到 trash；S3 实现 = 复制后删） */
  moveToTrash(keyPrefix: string): Promise<string>;
  /** 仅本地实现有：给出绝对路径，供 nginx alias 与开发期 Node 直出使用 */
  localPathOf(key: string): string | null;
  /**
   * 把一个已经在同分区备好的本地目录原子地纳入服务范围（本地实现 = rename；S3 实现 = 批量上传后写标记）。
   *
   * 这是 `moveToTrash` 的对称操作。§3.1 第 2 步"先 rename 到 releases 再写库"依赖它的原子性，
   * 而接口原文只给了移出方向，缺这个入口 commit 就只能在服务范围里逐文件写、失去原子语义。
   */
  moveIntoService(localPath: string, key: string): Promise<void>;
}

/** DI 令牌：业务只认接口，换实现不动调用方。 */
export const STORAGE_ADAPTER = 'protohub:storage-adapter';

/** `listPrefix()` 的一行：某个前缀下的直接子项（GC 扫描与 summary 日志用）。 */
export interface StorageEntry {
  /** 相对 STORAGE_ROOT 的 key，不带前导斜杠 */
  readonly key: string;
  readonly isDirectory: boolean;
  /** 最后修改时间（毫秒）。目录取自身 mtime——rename 进来那一刻就是它的年龄 */
  readonly mtimeMs: number;
  /** 字节数：文件是自身大小，目录是递归累计（summary 的"释放字节数"要它） */
  readonly sizeBytes: number;
}

/** 读取不存在的对象；调用方据此区分"没有产物"与"磁盘故障"。 */
export class StorageObjectMissingError extends Error {
  constructor(readonly key: string) {
    super(`存储对象不存在: ${key}`);
    this.name = 'StorageObjectMissingError';
  }
}

/** `localPathOf()` 判定为越界/空的 key：不解析成路径，直接拒绝。 */
export class StorageInvalidKeyError extends Error {
  constructor(readonly key: string) {
    super(`存储 key 不合法（必须是根目录之内、不含 .. 的相对路径）: ${key}`);
    this.name = 'StorageInvalidKeyError';
  }
}

/** 需要绝对路径的步骤（解压、清单副本、静态直出）唯一的取路径入口。 */
export function requireLocalPath(adapter: StorageAdapter, key: string): string {
  const abs = adapter.localPathOf(key);
  if (abs === null) {
    throw new StorageInvalidKeyError(key);
  }
  return abs;
}

/** 本地实现的启动期自查结论（tmp 与 releases 必须同挂载点，见 §1.3）。 */
export interface MountpointCheck {
  readonly detail: string;
  readonly ok: boolean;
}

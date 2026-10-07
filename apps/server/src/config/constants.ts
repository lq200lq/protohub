/**
 * 跨模块共用的固定标识。这些值来自设计文档，实现里不允许再抄第二遍字面量。
 */

/** 归一化后的 AppEnv 在 ConfigService 里的存放键。 */
export const APP_ENV_KEY = 'appEnv';

/** 接口前缀，见 后端接口设计.md §1.1（前端 VITE_GLOB_API_URL=/api）。 */
export const API_PREFIX = 'api';

/** Swagger UI 挂载路径，见 迭代实施计划 M0-T5。 */
export const SWAGGER_PATH = `${API_PREFIX}/docs`;

/** 追踪响应头，见 后端接口设计.md §1.5：响应头与日志里的 traceId 必须一致。 */
export const TRACE_ID_HEADER = 'X-Trace-Id';

/** 存储根目录下的固定子目录，见 迭代实施计划.md §3.1。 */
export const STORAGE_SUBDIRS = ['tmp', 'releases', 'manifests', 'trash'] as const;

export type StorageSubdir = (typeof STORAGE_SUBDIRS)[number];

/**
 * 四个必须互不相同的密钥（部署与运维方案.md §2）。
 * 顺序固定，用于错误信息里"谁和谁撞了"的可读输出。
 */
export const SECRET_ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'SESSION_COOKIE_SECRET',
  'ACCESS_TOKEN_SECRET',
] as const;

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number];

/** 密钥最小长度；短于此基本可以断定是示例值（生成方式 openssl rand -base64 48）。 */
export const SECRET_MIN_LENGTH = 32;

/** 被判定为敏感的日志字段名特征（大小写不敏感的子串匹配）。 */
export const SENSITIVE_KEY_PATTERNS = [
  'secret',
  'password',
  'token',
  'authorization',
] as const;

/** 敏感字段在日志里的替换值。 */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** 分页默认值与上限，见 后端接口设计.md §1.3。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/**
 * `visitsLast7d` 的统计窗口天数（后端接口设计 §4.1/§4.3）。
 * 口径同时写死两处判定：窗口 = 最近 7 天；计数只算**入口访问**（result=ok），
 * 资源请求的 404 日志不计访问量（原型发布与访问机制 §6：非入口资源请求不写 ok 日志）。
 */
export const VISITS_WINDOW_DAYS = 7;

/**
 * 编码自动生成的冲突重试上限（决策 D-20 + 计划 M2-T1/T3）：项目码与原型码共用同一口径。
 * 上限而不是死循环：撞码概率极低，连续命中说明另有原因（比如种子数据批量导入），该把错误抛给人看。
 */
export const CODE_AUTOGEN_MAX_RETRY = 5;

/**
 * 原型访问路径前缀（后端接口设计 §4.3：`/p/{项目码}/{原型码}`）。
 * 前缀同时出现在 nginx 的 location 与保留字表里，所以写成常量而不是在拼装处各抄一遍（§3.7 禁止硬编码路径）。
 */
export const PROTO_ACCESS_PREFIX = '/p';

/**
 * 访问决策链上的四个头名（后端接口设计 §9.1）。nginx 与我们各写一遍就会漂，
 * 尤其 `X-Original-URI` 是 nginx 侧配置里也要出现的字面量。
 */
export const ORIGINAL_URI_HEADER = 'X-Original-URI';

/** nginx 用 `$remote_addr` 覆盖写；来源白名单只认这一个头，不认 `X-Forwarded-For`（机制 §6）。 */
export const REAL_IP_HEADER = 'X-Real-IP';

/** 200 时必带，形状 `releases/{项目ID}/{原型ID}/{版本ID}`；nginx 侧经白名单 map 才取用（§9.1 C1）。 */
export const PROTO_RELEASE_DIR_HEADER = 'X-Proto-Release-Dir';

/** 非 200 时必带，门面页按它选形态（§9.1 C2）。 */
export const PROTO_REASON_HEADER = 'X-Proto-Reason';

/**
 * 访问密码最短长度（后端接口设计 §4.4：≥6 位）。
 */
export const ACCESS_PASSWORD_MIN_LENGTH = 6;

/**
 * 解锁接口的失败锁定（后端接口设计 §9.2：同 IP 连续失败 5 次锁 10 分钟）。
 *
 * 与登录那条（`LOGIN_FAIL_THRESHOLD`/`LOGIN_LOCK_SECONDS` = 5 次 / 15 分钟）是两个独立的数：
 * 登录锁的是"某个账号 + 某个 IP"，账号是人自己选的；这里锁的是匿名访问者，把窗口拉到 15 分钟
 * 只会让输错一次密码的客户多等 5 分钟，对防守没有增量。
 */
export const ACCESS_UNLOCK_FAIL_THRESHOLD = 5;
export const ACCESS_UNLOCK_LOCK_SECONDS = 10 * 60;

/**
 * 解锁失败计数的内存上限（与 `LoginLockService` 同一条理由：无上限就是拿请求体打内存）。
 * 超限直接清空：被清空的代价是"某几个 IP 的计数归零"，而内存打满的代价是整个服务。
 */
export const ACCESS_UNLOCK_MAX_TRACKED_KEYS = 1_000;

/**
 * 访问记录的批量写窗口（机制 §6：「上限 500 条或 2 秒」）。
 * 两条是**或**的关系：先到者触发 flush——峰值时靠条数封顶延迟，平时靠时间兜底不丢尾批。
 */
export const ACCESS_LOG_FLUSH_MAX_ROWS = 500;
export const ACCESS_LOG_FLUSH_INTERVAL_MS = 2_000;

/**
 * 待写缓冲的硬上限（机制 §6 没写这一条，实现必须有）：库连着失败时 2 秒一批堆积，
 * 没有上限就是拿访问流量把这台服务的内存打满。超限**丢新到的**并计数报警——
 * 统计完整性让位于静态访问的可用性，正是机制 §6 自己定的优先级。
 */
export const ACCESS_LOG_MAX_BUFFERED_ROWS = 2_000;

/**
 * 幂等键（后端接口设计 §1.5）：10 分钟内同键重复提交直接返回首次结果。
 * 窗口是"防手抖重提"，不是"永久去重"——超窗后同键可以再用，所以库里是普通索引（计划 §9 DEV-15）。
 */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

/** 幂等键长度上限（前端生成 UUID ≈36；超出即截断，`proto_upload_task.idempotency_key` 是 varchar(64)）。 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/**
 * multipart 单个文本字段的字节上限（`@fastify/multipart` 的 `limits.fieldSize`，busboy 默认只有 1024）。
 * `project`/`prototype` 是 JSON 串：500 个中文字符的说明（UTF-8 ≈1500 字节）加键名就超了默认值，
 * 而截断是**静默**的——JSON 解析报"参数不合法"，用户看不出自己哪里写长了（见 intake 的 valueTruncated 判定）。
 */
export const MULTIPART_FIELD_SIZE_BYTES = 4096;

/**
 * multipart 文本字段数量上限（`limits.fields`）。
 * §5.1 一共只有 6 个非文件字段，给到 8 是留出前端可能带的表单冗余；超出这个数的报文
 * 只可能是构造出来的，让 busboy 直接断流比让我们逐个解析便宜。
 */
export const MULTIPART_MAX_FIELDS = 8;

/** 上传文件名的落库长度上限（`proto_upload_task.source_name` varchar(300)）。 */
export const UPLOAD_SOURCE_NAME_MAX_LENGTH = 300;

/**
 * Worker 取任务的轮询间隔（机制 §3.3：「每 1 秒 `SELECT … FOR UPDATE SKIP LOCKED`」）。
 * 队列是数据库任务表 + 进程内循环，不是内存队列——1 秒是"用户点完发布到看见进度"的体感下限，
 * 再快也只是空转查询。
 */
export const UPLOAD_WORKER_POLL_MS = 1000;

/**
 * 卡死任务巡检间隔（机制 §3.2「启动时与每 5 分钟的巡检」）。
 * 进程被 kill 时任务会停在 `processing`，靠这条把它捞回 `pending`。
 */
export const UPLOAD_WORKER_SWEEP_MS = 5 * 60 * 1000;

/**
 * 任务被视为"卡死"的时长（机制 §3.2：超过 10 分钟）。
 * 判据是 `started_at`，不是 `updated_at`：一个还在推进的任务不需要续期，
 * 而真要续期就得防"永远不超时"，那条复杂度对单实例 v1 不值当。
 */
export const UPLOAD_TASK_STALE_MS = 10 * 60 * 1000;

/**
 * 卡死后允许的重投次数（机制 §3.2：「重置为 pending 并重试一次；第二次仍失败则置 failed」）。
 * `retry_count` 的上界，超过就直接失败并留 `UPLOAD_WORKER_FAILED`，不再无限重投。
 */
export const UPLOAD_TASK_MAX_RETRY = 1;

/**
 * 单份 HTML/CSS 允许进改写解析器的体积上限（机制 §2.6「性能保护：单文件 >5MB 的 HTML/CSS 跳过改写」）。
 *
 * 这条不是 §2.2 的那五个上传阈值（那些在 env 里可调，因为要跟使用者承诺），而是流水线自己的
 * 止损线：改写的收益是"少白屏"，代价是解析一份超大文件的 CPU/内存，畸形文件不值得为它冒这个代价。
 * 跳过时记 `REWRITE_TOO_LARGE` 警告，文件本身原样发布（§2.6 约束 3）。
 */
export const REWRITE_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * 版本号撞 `uk_proto_release_version` 时的重试上限（机制 §3.2：「唯一约束会兜底并触发重试（最多 3 次）」）。
 * 与编码抢码的 5 次（`CODE_AUTOGEN_MAX_RETRY`）是两个不同的数：编码空间是 base36、撞一次换个值就行，
 * 而版本号撞了说明同一原型正被并发发布，多试只是排队——3 次以后该让人知道有人在同时点发布。
 */
export const RELEASE_VERSION_MAX_RETRY = 3;

/**
 * 提交事务的超时（Prisma 交互式事务默认 5 秒）。
 *
 * 抬到 60 秒是因为这个事务里除了取号和写指针还夹了两次落盘（工作目录 rename、清单副本）。
 * rename 本身是 O(1)，但慢盘 + 大清单的组合同样能超过 5 秒，而超时会回滚一笔本来能成的发布。
 * 上界受 `UPLOAD_TASK_STALE_MS` 约束：事务比巡检还长就等于"库已被捞走、这边还在提交"。
 */
export const RELEASE_COMMIT_TX_TIMEOUT_MS = 60 * 1000;

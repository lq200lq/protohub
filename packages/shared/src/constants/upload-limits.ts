/**
 * 上传预检的口径（前端设计 §3.4 拖拽区文案、机制 §2.2 的阈值默认值）。
 *
 * 权威判定仍在服务端（env `MAX_UPLOAD_BYTES` + 413 响应）；界面这份只是"点提交之前就拦下来"的预检。
 * 之所以放进 shared 而不是前端写死 100MB：服务端的默认值读的就是这一个常量，
 * 于是不会出现"拖拽区说 100MB、服务端按别的数拒"这种让用户反复试探的失败。
 */
export const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 一期只收 zip（机制 §1）；扩展名判定是大小写无关的后缀匹配，不看 MIME（浏览器对 zip 的 MIME 不统一）。 */
export const UPLOAD_ACCEPT_EXTENSIONS = ['.zip'] as const;

/** 后端接口设计 §5.1：版本说明 ≤300 字（`proto_release.note` 是 varchar(300)）。 */
export const RELEASE_NOTE_MAX_LENGTH = 300;

/** §3.4 抽屉的项目名/原型名上限（与 `proto_project.name`、`proto_prototype.name` 的 varchar(80) 同口径）。 */
export const PUBLISH_NAME_MAX_LENGTH = 80;

/**
 * §3.4 抽屉「说明」的计数器上限 200（原型图上的 `0/200`）。
 *
 * 列宽是 500，这里收得更紧是刻意的：一次性表单里 200 字已经够写清"这是哪个页面的原型"，
 * 放宽只会让抽屉里出现一段占满屏幕的长文本。详情里的编辑表单不受这个上限约束。
 */
export const PUBLISH_DESCRIPTION_MAX_LENGTH = 200;

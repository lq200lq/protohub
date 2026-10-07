/** 失败 5 次锁 15 分钟（按 username + ip 计数），见后端接口设计 §2.1。 */
export const LOGIN_FAIL_THRESHOLD = 5;
export const LOGIN_LOCK_SECONDS = 15 * 60;

/**
 * 登录后的落地页。vben 优先用后端给的这个值（后端接口设计 §2.1）。
 * 与 sys_menu 里 `Workspace` 节点的 path 一致（数据库设计 §6.3）。
 */
export const HOME_PATH = '/dashboard/workspace';

import { PROTO_ACCESS_PREFIX } from '../config/constants';

/**
 * 原型访问路径的唯一拼装处（决策 D-01 的两级编码：`/p/{项目码}/{原型码}`）。
 *
 * 列出来有几处消费者：原型列表/详情（接口设计 §4.3）、上传发布受理与任务状态（§5.1/§5.3）、
 * 发布报告里的人话文案（原型发布与访问机制 §2.6）。前缀本身还同时出现在 nginx 的 location 与
 * 保留字表里，所以字面量只在 `PROTO_ACCESS_PREFIX` 一处，拼装也只在这一处（§3.7 禁止硬编码路径）。
 */
export function prototypeAccessPath(projectCode: string, code: string): string {
  return `${PROTO_ACCESS_PREFIX}/${projectCode}/${code}`;
}

/**
 * 完整访问 URL = 对外域名 + 访问路径（接口设计 §4.3：域名只从 `PUBLIC_BASE_URL` 来、只在服务端拼）。
 *
 * 单独成函数而不是各处写 `${base}${path}`：这条链接会出现在列表、详情、任务状态和发布前的预览里，
 * 少拼一次斜杠或多拼一个尾斜杠就是"链接点开 404"，而这类差异在四个消费点各写一遍时最容易漂。
 * `publicBaseUrl` 已由 config/env.ts 去掉尾部斜杠，所以这里直接接。
 */
export function accessUrlOf(publicBaseUrl: string, accessPath: string): string {
  return `${publicBaseUrl}${accessPath}`;
}

import type {
  CodeCheckResult,
  CreateProjectParams,
  PageResult,
  ProjectDetail,
  ProjectListItem,
  ProjectListQuery,
  ProjectMemberItem,
  ProjectUpdateResult,
  SetProjectMembersParams,
  UpdateProjectParams,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/projects（后端接口设计 §4.1.1）：keyword/status/sortBy/sortOrder + 分页 */
export function getProjectsApi(params: ProjectListQuery) {
  return requestClient.get<PageResult<ProjectListItem>>('/projects', {
    params,
  });
}

/** GET /api/projects/check-code?code=（§4.2）：code 省略/留空时返回 generated（将自动生成的编码） */
export function checkProjectCodeApi(code?: string) {
  return requestClient.get<CodeCheckResult>('/projects/check-code', {
    params: code ? { code } : {},
  });
}

/** POST /api/projects（§4.1.3）：code 省略即服务端生成 `p-xxxxxxxx`（D-20） */
export function createProjectApi(data: CreateProjectParams) {
  return requestClient.post<ProjectDetail>('/projects', data);
}

/** GET /api/projects/{id}（§4.1.4）：prototypeCount 在此是明细对象 */
export function getProjectDetailApi(id: string) {
  return requestClient.get<ProjectDetail>(`/projects/${id}`);
}

/** PUT /api/projects/{id}（§4.1.5）：只传 name/description；code 不可改（表单里没有它） */
export function updateProjectApi(id: string, data: UpdateProjectParams) {
  return requestClient.put<ProjectUpdateResult>(`/projects/${id}`, data);
}

/** DELETE /api/projects/{id}（§4.1.6）：软删，级联其下全部原型 */
export function deleteProjectApi(id: string) {
  return requestClient.delete<void>(`/projects/${id}`);
}

/**
 * POST /api/projects/{id}/archive（§4.1.7）：接口无请求参数，带 `{}` 让请求是个合法的 JSON 体；
 * 服务端（apps/server/src/main.ts 的自定义解析器）对空体同样放行。
 */
export function archiveProjectApi(id: string) {
  return requestClient.post<ProjectDetail>(`/projects/${id}/archive`, {});
}

/** POST /api/projects/{id}/unarchive（§4.1.8） */
export function unarchiveProjectApi(id: string) {
  return requestClient.post<ProjectDetail>(`/projects/${id}/unarchive`, {});
}

/** GET /api/projects/{id}/members（§4.1.9） */
export function getProjectMembersApi(id: string) {
  return requestClient.get<ProjectMemberItem[]>(`/projects/${id}/members`);
}

/** PUT /api/projects/{id}/members（§4.1.10）：覆盖式；请求键是 `members`（不是 memberIds） */
export function setProjectMembersApi(id: string, data: SetProjectMembersParams) {
  return requestClient.put<ProjectMemberItem[]>(
    `/projects/${id}/members`,
    data,
  );
}

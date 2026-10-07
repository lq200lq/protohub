import type {
  CodeCheckResult,
  CreatePrototypeParams,
  PageResult,
  PrototypeDetail,
  PrototypeListItem,
  PrototypeListQuery,
  PrototypeUpdateResult,
  UpdatePrototypeParams,
  UpdatePrototypePolicyParams,
} from '@protohub/shared';

import { requestClient } from '#/api/request';

/** GET /api/prototypes（后端接口设计 §4.3.1）：projectId 必填，缺它服务端直接 400 */
export function getPrototypesApi(params: PrototypeListQuery) {
  return requestClient.get<PageResult<PrototypeListItem>>('/prototypes', {
    params,
  });
}

/**
 * GET /api/prototypes/check-code?projectId=&code=（§4.3.2）：
 * code 留空返回 generated（`{项目码}-pNN`，项目内递增）。
 */
export function checkPrototypeCodeApi(projectId: string, code?: string) {
  return requestClient.get<CodeCheckResult>('/prototypes/check-code', {
    params: code ? { code, projectId } : { projectId },
  });
}

/** POST /api/prototypes（§4.3.3）：创建草稿原型；code 省略即服务端生成 */
export function createPrototypeApi(data: CreatePrototypeParams) {
  return requestClient.post<PrototypeDetail>('/prototypes', data);
}

/** GET /api/prototypes/{id}（§4.3.4）：含 accessUrl、策略与当前版本摘要 */
export function getPrototypeDetailApi(id: string) {
  return requestClient.get<PrototypeDetail>(`/prototypes/${id}`);
}

/** PUT /api/prototypes/{id}（§4.3.5）：name/description/sort；code 不可改（表单里没有它） */
export function updatePrototypeApi(id: string, data: UpdatePrototypeParams) {
  return requestClient.put<PrototypeUpdateResult>(`/prototypes/${id}`, data);
}

/** DELETE /api/prototypes/{id}（§4.3.6）：软删，级联其全部版本产物 */
export function deletePrototypeApi(id: string) {
  return requestClient.delete<void>(`/prototypes/${id}`);
}

/** POST /api/prototypes/{id}/archive（§4.3.7）：必须带 `{}` body（服务端拒绝空 JSON body） */
export function archivePrototypeApi(id: string) {
  return requestClient.post<PrototypeDetail>(`/prototypes/${id}/archive`, {});
}

/** POST /api/prototypes/{id}/unarchive（§4.3.8） */
export function unarchivePrototypeApi(id: string) {
  return requestClient.post<PrototypeDetail>(`/prototypes/${id}/unarchive`, {});
}

/**
 * PUT /api/prototypes/{id}/policy（§4.4）：只发 accessMode/password；
 * 服务端 strict 校验拒绝未知键（memberIds 无处可落，detail 里的 memberIds 是项目成员派生的只读值）。
 */
export function updatePrototypePolicyApi(
  id: string,
  data: UpdatePrototypePolicyParams,
) {
  return requestClient.put<PrototypeDetail>(`/prototypes/${id}/policy`, data);
}

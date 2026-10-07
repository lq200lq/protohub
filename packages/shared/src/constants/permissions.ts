/** 权限码唯一来源（权限模型设计 §3），数组顺序即 sys_permission.sort；seed 与 Guard/前端都读这里 */
export const PERMISSIONS = [
  { code: 'dashboard:workspace:view', name: '工作台首页', module: 'dashboard' },

  { code: 'proto:project:list', name: '项目列表', module: 'proto' },
  { code: 'proto:project:read', name: '项目详情', module: 'proto' },
  { code: 'proto:project:create', name: '新建项目', module: 'proto' },
  { code: 'proto:project:update', name: '编辑项目', module: 'proto' },
  { code: 'proto:project:delete', name: '删除项目', module: 'proto' },
  { code: 'proto:project:archive', name: '归档/下架项目', module: 'proto' },

  { code: 'proto:prototype:list', name: '原型列表', module: 'proto' },
  { code: 'proto:prototype:read', name: '原型详情', module: 'proto' },
  { code: 'proto:prototype:create', name: '新建原型', module: 'proto' },
  { code: 'proto:prototype:update', name: '编辑原型', module: 'proto' },
  { code: 'proto:prototype:delete', name: '删除原型', module: 'proto' },
  { code: 'proto:prototype:archive', name: '归档/下架原型', module: 'proto' },
  { code: 'proto:prototype:policy', name: '访问策略', module: 'proto' },
  { code: 'proto:prototype:publish', name: '上传发布', module: 'proto' },
  { code: 'proto:prototype:rollback', name: '版本回滚', module: 'proto' },

  { code: 'proto:release:list', name: '版本列表', module: 'proto' },
  { code: 'proto:release:delete', name: '删除版本', module: 'proto' },
  { code: 'proto:release:download', name: '下载版本产物', module: 'proto' },

  { code: 'proto:accesslog:list', name: '访问记录', module: 'proto' },
  { code: 'proto:accesslog:export', name: '导出访问记录', module: 'proto' },

  { code: 'system:user:list', name: '用户列表', module: 'system' },
  { code: 'system:user:read', name: '用户详情', module: 'system' },
  { code: 'system:user:create', name: '新建用户', module: 'system' },
  { code: 'system:user:update', name: '编辑用户', module: 'system' },
  { code: 'system:user:delete', name: '删除用户', module: 'system' },
  { code: 'system:user:resetpwd', name: '重置他人密码', module: 'system' },
  { code: 'system:user:assignrole', name: '分配用户角色', module: 'system' },
  { code: 'system:role:list', name: '角色列表', module: 'system' },
  { code: 'system:role:read', name: '角色详情', module: 'system' },
  { code: 'system:role:create', name: '新建角色', module: 'system' },
  { code: 'system:role:update', name: '编辑角色', module: 'system' },
  { code: 'system:role:delete', name: '删除角色', module: 'system' },
  { code: 'system:role:assignperm', name: '角色授权', module: 'system' },
  { code: 'system:menu:list', name: '菜单列表', module: 'system' },
  { code: 'system:menu:create', name: '新建菜单', module: 'system' },
  { code: 'system:menu:update', name: '编辑菜单', module: 'system' },
  { code: 'system:menu:delete', name: '删除菜单', module: 'system' },
  { code: 'system:log:list', name: '查看日志', module: 'system' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];
export type PermissionModule = (typeof PERMISSIONS)[number]['module'];

export const PERMISSION_CODES: PermissionCode[] = PERMISSIONS.map(
  (permission) => permission.code,
);

const PERMISSION_CODE_SET: ReadonlySet<string> = new Set<string>(PERMISSION_CODES);

export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODE_SET.has(value);
}

/** 权限码字典接口（后端接口设计 §7.4）按 module 分组返回 */
export function groupPermissionsByModule(): Array<{
  module: PermissionModule;
  permissions: (typeof PERMISSIONS)[number][];
}> {
  const groups = new Map<PermissionModule, (typeof PERMISSIONS)[number][]>();
  for (const permission of PERMISSIONS) {
    const existing = groups.get(permission.module);
    if (existing) {
      existing.push(permission);
    } else {
      groups.set(permission.module, [permission]);
    }
  }
  return [...groups].map(([module, permissions]) => ({ module, permissions }));
}

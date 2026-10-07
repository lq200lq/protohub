/**
 * 菜单树种子（数据库设计 §6.3 + 前端设计 §2/§3/§4）。
 *
 * 结构：扁平一级菜单（工作台/原型项目/上传发布/访问记录/设置 + 两个 hideInMenu 详情页 + Profile），
 * 每个"写操作"权限码都有一个 type='button' 节点（权限模型 §3.7：按钮节点只是授权树的
 * 勾选骨架，最终权限仍以 sys_role_permission 为准）。
 *
 * §6.3 表格未列出的按钮（版本删除/下载、访问记录导出、用户/角色/菜单写操作、日志查看之外的
 * 管理动作）按同一规则补齐："每个写动作一个按钮、pid 挂最近的页面节点"。
 * authCode 的类型是 shared 的 PermissionCode——写错码编译期就报错；运行期再对
 * `PERMISSIONS` 做一次包含性断言，防 shared 与文档漂移。
 */
import { PERMISSIONS, isPermissionCode, type PermissionCode } from '@protohub/shared';

export interface MenuSeedNode {
  name: string;
  type: 'catalog' | 'menu' | 'button';
  title: string;
  /** 父节点 name（顶层为 null）；§6.3 注：按钮挂最近的页面节点 */
  parent?: string;
  path?: string;
  /** 相对 apps/admin/src/views、不带 /views 前缀（数据库设计 §6.3 component 规则） */
  component?: string;
  authCode?: PermissionCode;
  icon?: string;
  sort?: number;
  affixTab?: boolean;
  hideInMenu?: boolean;
}

/** button 节点简写：标题直接取 PERMISSIONS 里该码的 name（同一来源，不再手写第二份文案）。 */
function button(name: string, parent: string, code: PermissionCode): MenuSeedNode {
  const def = PERMISSIONS.find((p) => p.code === code);
  if (!def || !isPermissionCode(code)) {
    // 编译期 PermissionCode + 运行期 shared 断言双保险（shared 是权限码唯一权威）
    throw new Error(`[seed/menus] 权限码不在 PERMISSIONS 中: ${code}`);
  }
  return { name, type: 'button', title: def.name, parent, authCode: code };
}

export const MENU_SEED: readonly MenuSeedNode[] = [
  // ── 页面节点（§6.3 表格逐行对齐） ─────────────────────────────────────────
  {
    name: 'Workspace',
    type: 'menu',
    title: '工作台',
    path: '/dashboard/workspace',
    component: '/dashboard/workspace/index',
    icon: 'lucide:layout-dashboard',
    sort: 1,
    affixTab: true,
  },
  {
    name: 'ProtoProject',
    type: 'menu',
    title: '原型项目',
    path: '/proto/project',
    component: '/proto/project/index',
    icon: 'lucide:folder-code',
    sort: 2,
  },
  {
    name: 'ProtoProjectDetail',
    type: 'menu',
    title: '项目详情',
    path: '/proto/project/detail',
    component: '/proto/project/detail/index',
    sort: 3,
    hideInMenu: true,
  },
  {
    name: 'ProtoPrototypeDetail',
    type: 'menu',
    title: '原型详情',
    path: '/proto/prototype/detail',
    component: '/proto/prototype/detail/index',
    sort: 4,
    hideInMenu: true,
  },
  {
    name: 'ProtoPublish',
    type: 'menu',
    title: '上传发布',
    path: '/proto/publish',
    component: '/proto/publish/index',
    icon: 'lucide:cloud-upload',
    sort: 5,
  },
  {
    name: 'ProtoAccessLog',
    type: 'menu',
    title: '访问记录',
    path: '/proto/accesslog',
    component: '/proto/accesslog/index',
    icon: 'lucide:chart-line',
    sort: 6,
  },
  {
    name: 'SystemSetting',
    type: 'menu',
    title: '设置',
    path: '/system/setting',
    component: '/system/setting/index',
    icon: 'lucide:settings',
    sort: 99,
  },
  {
    name: 'Profile',
    type: 'menu',
    title: '个人中心',
    path: '/profile',
    component: '/_core/profile/index',
    sort: 100,
    hideInMenu: true,
  },

  // ── 项目按钮（挂 ProtoProject，§6.3） ────────────────────────────────────
  button('ProtoProjectCreate', 'ProtoProject', 'proto:project:create'),
  button('ProtoProjectUpdate', 'ProtoProject', 'proto:project:update'),
  button('ProtoProjectDelete', 'ProtoProject', 'proto:project:delete'),
  button('ProtoProjectArchive', 'ProtoProject', 'proto:project:archive'),

  // ── 原型按钮（挂 ProtoPrototypeDetail，§6.3：原型操作入口都在原型详情） ──
  button('ProtoPrototypeCreate', 'ProtoPrototypeDetail', 'proto:prototype:create'),
  button('ProtoPrototypeUpdate', 'ProtoPrototypeDetail', 'proto:prototype:update'),
  button('ProtoPrototypeDelete', 'ProtoPrototypeDetail', 'proto:prototype:delete'),
  button('ProtoPrototypeArchive', 'ProtoPrototypeDetail', 'proto:prototype:archive'),
  button('ProtoPrototypePolicy', 'ProtoPrototypeDetail', 'proto:prototype:policy'),
  button('ProtoPrototypePublish', 'ProtoPrototypeDetail', 'proto:prototype:publish'),
  button('ProtoPrototypeRollback', 'ProtoPrototypeDetail', 'proto:prototype:rollback'),
  // 版本动作也落在原型详情页的版本记录区（§3.5）；download 为 P1，先建节点保证授权树完整
  button('ProtoReleaseDelete', 'ProtoPrototypeDetail', 'proto:release:delete'),
  button('ProtoReleaseDownload', 'ProtoPrototypeDetail', 'proto:release:download'),

  // ── 访问记录导出（P1，权限模型 §3.5） ────────────────────────────────────
  button('ProtoAccesslogExport', 'ProtoAccessLog', 'proto:accesslog:export'),

  // ── 系统管理按钮（挂 SystemSetting；Tab 级权限即 §3.8 的按钮码，写动作逐条补） ──
  button('SystemUserManage', 'SystemSetting', 'system:user:list'),
  button('SystemUserCreate', 'SystemSetting', 'system:user:create'),
  button('SystemUserUpdate', 'SystemSetting', 'system:user:update'),
  button('SystemUserDelete', 'SystemSetting', 'system:user:delete'),
  button('SystemUserResetPwd', 'SystemSetting', 'system:user:resetpwd'),
  button('SystemUserAssignRole', 'SystemSetting', 'system:user:assignrole'),
  button('SystemRoleManage', 'SystemSetting', 'system:role:list'),
  button('SystemRoleCreate', 'SystemSetting', 'system:role:create'),
  button('SystemRoleUpdate', 'SystemSetting', 'system:role:update'),
  button('SystemRoleDelete', 'SystemSetting', 'system:role:delete'),
  button('SystemRoleAssignPerm', 'SystemSetting', 'system:role:assignperm'),
  button('SystemMenuManage', 'SystemSetting', 'system:menu:list'),
  button('SystemMenuCreate', 'SystemSetting', 'system:menu:create'),
  button('SystemMenuUpdate', 'SystemSetting', 'system:menu:update'),
  button('SystemMenuDelete', 'SystemSetting', 'system:menu:delete'),
  button('SystemLogView', 'SystemSetting', 'system:log:list'),
] as const;

/**
 * 角色 → 菜单节点 name（数据库设计 §8.3-4"为内置角色建立角色-菜单关联"）。
 * button 节点自动跟随角色权限码集合（§3.7），这里只声明页面节点的差异：
 * viewer 不给「上传发布」页（它没有 publish 码，进去也是 403，不如不下发）。
 */
export function menuNodeNamesFor(role: 'super_admin' | 'admin' | 'publisher' | 'viewer'): string[] {
  const pages = MENU_SEED.filter((n) => n.type !== 'button').map((n) => n.name);
  if (role === 'viewer') {
    return pages.filter((n) => n !== 'ProtoPublish');
  }
  return pages;
}

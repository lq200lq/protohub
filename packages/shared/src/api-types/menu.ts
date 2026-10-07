/** GET /api/menu/all 返回的 meta（数据库 sys_menu 字段映射后的形态，§2.6） */
export interface RouteMeta {
  affixTab?: boolean;
  /** 逗号分隔角色 → 字符串数组 */
  authority?: string[];
  badge?: string;
  badgeType?: string;
  hideInMenu?: boolean;
  icon?: string;
  /** type=embedded */
  iframeSrc?: string;
  ignoreAccess?: boolean;
  keepAlive?: boolean;
  /** type=link */
  link?: string;
  menuVisibleWithForbidden?: boolean;
  openInNewWindow?: boolean;
  order?: number;
  title: string;
}

/**
 * 路由树节点，不是 sys_menu 原样：component 是相对 apps/admin/src/views 的路径字符串，
 * embedded/link 时固定为 'IFrameView'；type='button' 的节点不下发（按钮权限走 /auth/codes）。
 */
export interface RouteRecordStringComponent {
  children?: RouteRecordStringComponent[];
  component: string;
  meta: RouteMeta;
  name: string;
  path: string;
  redirect?: string;
}

export type MenuRouteTree = RouteRecordStringComponent[];

import type { MenuTreeNode } from '@protohub/shared';

/**
 * sys_menu 树（含 button 节点，来自 GET /system/menus）到各消费形态的纯转换。
 * 单测覆盖：勾选树、扁平表行、父级选择项。
 */

export interface CheckableTreeNode {
  children?: CheckableTreeNode[];
  key: string;
  title: string;
}

/**
 * antd Tree 勾选树节点。
 * 角色授权的菜单树要排除 button 节点（按钮权限走 /auth/codes + 权限码勾选，
 * 见后端接口设计 §2.7），菜单管理自己的树则原样保留。
 */
export function menuTreeToCheckableTree(
  nodes: readonly MenuTreeNode[],
  options: { excludeButtons?: boolean } = {},
): CheckableTreeNode[] {
  return nodes
    .filter((node) => !(options.excludeButtons && node.type === 'button'))
    .map((node) => {
      const children = node.children?.length
        ? menuTreeToCheckableTree(node.children, options)
        : undefined;
      return children
        ? { children, key: node.id, title: node.title }
        : { key: node.id, title: node.title };
    });
}

/** vxe 树表 transform 模式需要带 pid 的扁平行（pid 已在 MenuTreeNode 上） */
export interface FlatMenuRow extends Omit<MenuTreeNode, 'children'> {
  childrenCount: number;
}

export function flattenMenuTree(
  nodes: readonly MenuTreeNode[],
): FlatMenuRow[] {
  const out: FlatMenuRow[] = [];
  for (const node of nodes) {
    const { children = [], ...rest } = node;
    out.push({ ...rest, childrenCount: children.length });
    out.push(...flattenMenuTree(children));
  }
  return out;
}

/** 父级选择项：button 不能当父级；编辑时排除自身及其子孙 */
export interface MenuParentOption {
  children?: MenuParentOption[];
  value: string;
  label: string;
}

export function menuTreeToParentOptions(
  nodes: readonly MenuTreeNode[],
  excludeId?: string,
): MenuParentOption[] {
  const out: MenuParentOption[] = [];
  for (const node of nodes) {
    if (node.id === excludeId) {
      // 排除自身时连同其子树一起排除，否则会出现"自己是自己父级"的环
      continue;
    }
    if (node.type === 'button') {
      continue;
    }
    const children = node.children?.length
      ? menuTreeToParentOptions(node.children, excludeId)
      : undefined;
    out.push(
      children?.length
        ? { children, label: node.title, value: node.id }
        : { label: node.title, value: node.id },
    );
  }
  return out;
}

/** 收集树上全部节点 id（全选操作用） */
export function collectMenuTreeIds(nodes: readonly MenuTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    node.id,
    ...collectMenuTreeIds(node.children ?? []),
  ]);
}

/**
 * 勾选结果 → 提交的 menuIds：只保留真实存在于菜单树上的 id。
 * Tree 的勾选态里可能混入半选/历史残留 key，覆盖式提交（§7.2.6）前必须收口。
 */
export function pickMenuIds(
  checkedKeys: readonly (number | string)[],
  nodes: readonly MenuTreeNode[],
): string[] {
  const known = new Set(collectMenuTreeIds(nodes));
  return checkedKeys.map(String).filter((key) => known.has(key));
}

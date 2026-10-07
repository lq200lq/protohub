import type { RouteRecordStringComponent } from '@vben/types';

import { describe, expect, it } from 'vitest';

import { filterMenusByAccess } from './menu-access';

function menu(
  name: string,
  children?: RouteRecordStringComponent[],
): RouteRecordStringComponent {
  return {
    component: `/${name}/index`,
    name,
    path: `/${name}`,
    ...(children ? { children } : {}),
  };
}

function settingTree(): RouteRecordStringComponent[] {
  return [
    menu('Workspace'),
    menu('SystemSetting', [
      menu('SystemSettingSecurity'),
      menu('SystemSettingUser'),
      menu('SystemSettingRole'),
      menu('SystemSettingMenu'),
      menu('SystemSettingLog'),
    ]),
  ];
}

describe('filterMenusByAccess', () => {
  it('无任何权限码时，系统设置只留无需码的账号安全', () => {
    const result = filterMenusByAccess(settingTree(), []);
    expect(result).toHaveLength(2);
    expect(result[1]?.children?.map((child) => child.name)).toEqual([
      'SystemSettingSecurity',
    ]);
  });

  it('只持有一个码时保留对应子菜单，其余照剪', () => {
    const result = filterMenusByAccess(settingTree(), ['system:menu:list']);
    expect(result[1]?.children?.map((child) => child.name)).toEqual([
      'SystemSettingSecurity',
      'SystemSettingMenu',
    ]);
  });

  it('全部码在手时整棵树原样保留', () => {
    const result = filterMenusByAccess(settingTree(), [
      'system:user:list',
      'system:role:list',
      'system:menu:list',
      'system:log:list',
    ]);
    expect(result[1]?.children).toHaveLength(5);
  });

  it('不在映射表里的节点一律不动', () => {
    const result = filterMenusByAccess([menu('Workspace')], []);
    expect(result.map((item) => item.name)).toEqual(['Workspace']);
  });

  it('受控节点出现在更深层级时同样被剪', () => {
    const result = filterMenusByAccess([menu('Group', [menu('SystemSettingUser')])], []);
    expect(result[0]?.children).toEqual([]);
  });
});

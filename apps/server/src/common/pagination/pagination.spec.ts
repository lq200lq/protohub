import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../config/constants';
import { normalizePageQuery, toPageData } from './pagination';

describe('分页约定（后端接口设计 §1.3 / §1.5）', () => {
  it('缺省用第 1 页、每页 20 条', () => {
    expect(normalizePageQuery()).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
    });
  });

  it('query 里的字符串数字被吃下，skip 按页算', () => {
    expect(normalizePageQuery({ page: '3', pageSize: '10' })).toEqual({
      page: 3,
      pageSize: 10,
      skip: 20,
    });
  });

  it('pageSize 超过 200 直接夹取，不报错', () => {
    const query = normalizePageQuery({ page: 1, pageSize: 5_000 });

    expect(query.pageSize).toBe(MAX_PAGE_SIZE);
    expect(query.page).toBe(1);
  });

  it('非法页码/条数回落到默认值，而不是抛出 400', () => {
    expect(normalizePageQuery({ page: 'abc', pageSize: '-2' })).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
    });
  });

  it('sortBy / sortOrder 只在给合法值时出现', () => {
    expect(
      normalizePageQuery({ sortBy: ' createdAt ', sortOrder: 'DESC' }),
    ).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      skip: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
    expect(normalizePageQuery({ sortOrder: 'sideways' }).sortOrder).toBeUndefined();
  });

  it('响应体形状是 { items, total }', () => {
    expect(toPageData(['a', 'b'], 137)).toEqual({ items: ['a', 'b'], total: 137 });
  });
});

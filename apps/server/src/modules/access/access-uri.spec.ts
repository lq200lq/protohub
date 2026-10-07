import { describe, expect, it } from 'vitest';

import { isEntryDocument, parseAccessUri } from './access-uri';

/**
 * `X-Original-URI` 解析单测（计划 M4-T3；接口设计 §9.1 的头表 + 机制 §5.1 的 target）。
 * 钉的是"只认两段的形态"：解析不出来一律 null，由调用方给 404——
 * 这个接口不能多出第五种状态码（nginx 的 error_page 映射只有 401/403/404 三条）。
 */
describe('parseAccessUri：从 X-Original-URI 取两级编码', () => {
  it('目录根写法：两段编码 + 空资源路径（nginx 的入口请求就是这个形态）', () => {
    expect(parseAccessUri('/p/crm/crm-p01/')).toEqual({
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      resourcePath: '',
    });
  });

  it('省略尾斜杠同样成立（手敲链接、群里被截断的链接都会这样）', () => {
    expect(parseAccessUri('/p/crm/crm-p01')?.resourcePath).toBe('');
  });

  it('子资源路径原样带出，不参与编码判定', () => {
    expect(parseAccessUri('/p/crm/crm-p01/assets/app.js')).toEqual({
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      resourcePath: '/assets/app.js',
    });
  });

  it('查询串要剥掉（nginx 传的是 $request_uri，带 ? 是常态）', () => {
    expect(parseAccessUri('/p/crm/crm-p01/index.html?from=im&x=1')).toEqual({
      projectCode: 'crm',
      prototypeCode: 'crm-p01',
      resourcePath: '/index.html',
    });
  });

  it('多级目录的资源路径保持完整（深层 assets 不能只取一段）', () => {
    expect(parseAccessUri('/p/crm/crm-p01/a/b/c.html')?.resourcePath).toBe('/a/b/c.html');
  });

  it('百分号编码的编码要解开：`crm%2Dp01` 就是 `crm-p01`', () => {
    expect(parseAccessUri('/p/crm/crm%2Dp01/')?.prototypeCode).toBe('crm-p01');
  });

  it('单段路径 → null（Gate M4 G6：/p/crm 是 404，不是管理台）', () => {
    expect(parseAccessUri('/p/crm')).toBeNull();
    expect(parseAccessUri('/p/crm/')).toBeNull();
  });

  it('非 /p/ 前缀一律不认（这个头只描述原型访问请求）', () => {
    for (const raw of [
      undefined,
      '',
      '/',
      '/p',
      '/prototypes/crm/p01',
      '/api/access/check',
      '/P/crm/crm-p01',
    ]) {
      expect(parseAccessUri(raw)).toBeNull();
    }
  });

  it('中间出现空段不认：URI 畸形时 nginx 匹配的原型可能与前两段不同', () => {
    expect(parseAccessUri('/p//crm-p01/')).toBeNull();
    expect(parseAccessUri('/p/crm//assets/app.js')).toBeNull();
    expect(parseAccessUri('//p/crm/crm-p01/')).toBeNull();
  });

  it('解开转义后仍要过编码规则：`%2F..%2F` 这类路径片段出不去', () => {
    for (const raw of [
      '/p/crm/a%2Fb',
      '/p/crm/..%2Fetc%2Fpasswd',
      '/p/crm/crm-p01%00',
      '/p/crm/CRM-P01',
      '/p/crm/crm_p01',
      '/p/crm-p01/-dup',
      '/p/crm/%2e%2e',
    ]) {
      expect(parseAccessUri(raw)).toBeNull();
    }
  });

  it('非法百分号转义不抛异常（decodeURIComponent 会抛，这里必须包住）', () => {
    expect(parseAccessUri('/p/crm/crm%ZZp01')).toBeNull();
    expect(parseAccessUri('/p/cr%o/crm-p01')).toBeNull();
  });

  it('超长编码（>63）拒掉，不给库里的 varchar 列制造截断', () => {
    const long = `p-${'a'.repeat(70)}`;
    expect(parseAccessUri(`/p/${long}/crm-p01`)).toBeNull();
  });
});

describe('isEntryDocument：只有入口访问写 ok 日志（机制 §6）', () => {
  it('目录根与 index.html 都算入口（大小写不敏感，静态服务器就是这么找的）', () => {
    for (const path of ['/p/crm/crm-p01/', '/p/crm/crm-p01', '/p/crm/crm-p01/index.html', '/p/crm/crm-p01/Index.HTML']) {
      const target = parseAccessUri(path);
      expect(target && isEntryDocument(target), path).toBe(true);
    }
  });

  it('其它 HTML 与资源都不算入口：一个原型 40 个资源全记会让访问量虚高 40 倍', () => {
    for (const path of ['/p/crm/crm-p01/page2.html', '/p/crm/crm-p01/assets/app.js', '/p/crm/crm-p01/a/']) {
      const target = parseAccessUri(path);
      expect(target && isEntryDocument(target), path).toBe(false);
    }
  });

  it('`/a/` 这种目录里的子路径不会被当成入口（尾斜杠只可能在根上出现）', () => {
    const target = parseAccessUri('/p/crm/crm-p01/a/');
    expect(target?.resourcePath).toBe('/a');
  });
});

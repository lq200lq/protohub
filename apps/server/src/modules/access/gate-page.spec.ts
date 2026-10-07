import { describe, expect, it } from 'vitest';

import { parseGateQuery, renderGatePage } from './gate-page';

/**
 * 门面页（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5.3；M4-T6，Gate G9）。
 *
 * 这里不桩任何东西：整个模块就是一个"输入进来 → 页面出去"的纯函数，
 * 而它的安全性质（不猜形态、不给开放重定向、不吐业务信息、不引外部文件）全在这条线上。
 */
const BASE = 'https://proto.example.com';

function render(query: Record<string, unknown>): string {
  return renderGatePage(parseGateQuery(query), BASE);
}

/** 形态判定的唯一观察点：密码形态有 `<form>`，登录形态有指向登录页的 `<a>`。 */
const PASSWORD_FORM = {
  code: '401',
  project: 'p-z2jo4sob',
  prototype: 'p-z2jo4sob-p01',
  reason: 'NEED_PASSWORD',
};

describe('机制 §5.3 的五种形态', () => {
  it('401 NEED_PASSWORD：密码表单，提交目标是那两段编码拼出来的 unlock', () => {
    const html = render(PASSWORD_FORM);

    expect(html).toContain('该原型需要访问密码');
    expect(html).toContain('type="password"');
    expect(html).toContain('action="/api/access/p-z2jo4sob/p-z2jo4sob-p01/unlock"');
  });

  it('403 NEED_LOGIN：去登录，并把原地址带进 redirect', () => {
    const html = render({
      code: '403',
      reason: 'NEED_LOGIN',
      from: '/p/crm/crm-p01/index.html',
    });

    expect(html).toContain('该原型仅限内部成员查看');
    expect(html).toContain(
      'href="https://proto.example.com/auth/login?redirect=%2Fp%2Fcrm%2Fcrm-p01%2Findex.html"',
    );
    // 内部成员看门不通时不该出现密码框：那是另一条凭据链路
    expect(html).not.toContain('<form');
  });

  it.each([
    ['NO_PERMISSION', '你没有查看该原型的权限'],
    ['PROTOTYPE_ARCHIVED', '该原型已下架'],
    ['PROJECT_ARCHIVED', '该原型所属项目已下架'],
  ] as const)('403 %s：%s', (reason, copy) => {
    const html = render({ code: '403', reason });

    expect(html).toContain(copy);
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/auth/login');
  });

  it('404 不区分"不存在"与"未发布"：两种原因渲染出逐字相同的页面', () => {
    const notFound = render({ code: '404', reason: 'NOT_FOUND' });
    const notPublished = render({ code: '404', reason: 'NOT_PUBLISHED' });

    expect(notFound).toBe(notPublished);
    expect(notFound).toContain('链接无效或已失效');
    // R-9：这句措辞不能反过来告诉访问者"它存在但没发布"
    expect(notFound).not.toContain('未发布');
  });
});

describe('参数不认时一律往保守方向退', () => {
  it.each([
    [{ code: '500', reason: 'NEED_LOGIN' }, 'status 码不在那三个里'],
    [{ reason: 'NEED_LOGIN' }, '缺 status 码'],
    [{ code: '' }, '空 status 码'],
  ])('%s → 与 404 同一页（%s）', (query, _label) => {
    expect(render(query)).toBe(render({ code: '404' }));
  });

  it.each([
    [{ code: '403' }, '403 但没带原因'],
    [{ code: '403', reason: 'SOMETHING_ELSE' }, '原因不在枚举里，不猜'],
    [{ code: '401', reason: 'NOT_FOUND' }, '401 配上一个不该出现的原因'],
  ])('%s → 中性兜底页（%s）', (query, _label) => {
    const html = render(query);

    expect(html).toContain('该原型暂时无法访问');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('/auth/login');
  });

  it('401 但编码不合法时不给"没有出口的密码框"，退成链接无效', () => {
    const html = render({
      code: '401',
      reason: 'NEED_PASSWORD',
      project: '../etc',
      prototype: 'CRM-P01',
    });

    expect(html).toContain('链接无效或已失效');
    expect(html).not.toContain('<form');
  });

  it.each([
    ['缺 prototype', { code: '401', project: 'crm', reason: 'NEED_PASSWORD' }],
    ['大写', { code: '401', project: 'crm', prototype: 'CRM-P01', reason: 'NEED_PASSWORD' }],
    ['保留字', { code: '401', project: 'admin', prototype: 'admin-p01', reason: 'NEED_PASSWORD' }],
    ['空串', { code: '401', project: '', prototype: '', reason: 'NEED_PASSWORD' }],
  ])('编码 %s 时没有表单（它会被拼进 action，不合法就不能用）', (_label, query) => {
    expect(render(query)).not.toContain('<form');
  });
});

describe('from 只会是站内 /p/ 路径（开放重定向）', () => {
  it.each([
    '//evil.example/x',
    'https://evil.example/x',
    'HTTP://evil.example/x',
    '/admin/users',
    'javascript:alert(1)',
    '/p/../admin',
    `/p/crm/${'x'.repeat(600)}`,
  ])('%s 不会被拼进登录地址', (from) => {
    const html = render({ code: '403', reason: 'NEED_LOGIN', from });

    expect(html).not.toContain('redirect=');
    expect(html).toContain('href="https://proto.example.com/auth/login"');
  });

  it('带尾斜杠的站内地址会原样保留（回来还要落在同一个文件上）', () => {
    const html = render({
      code: '403',
      reason: 'NEED_LOGIN',
      from: '/p/crm/crm-p01/',
    });

    expect(html).toContain(
      'href="https://proto.example.com/auth/login?redirect=%2Fp%2Fcrm%2Fcrm-p01%2F"',
    );
  });

  it('没有 from 时只跳到登录页，不带空的 redirect', () => {
    expect(render({ code: '403', reason: 'NEED_LOGIN' })).toContain(
      'href="https://proto.example.com/auth/login"',
    );
  });
});

describe('页面里搜不到业务信息（Gate G9）', () => {
  const secret = '客户A的官网原型';

  it.each([
    [{ ...PASSWORD_FORM }],
    [{ code: '403', reason: 'NEED_LOGIN', from: '/p/crm/crm-p01/' }],
    [{ code: '403', reason: 'NO_PERMISSION' }],
    [{ code: '403', reason: 'PROTOTYPE_ARCHIVED' }],
    [{ code: '404', reason: 'NOT_FOUND' }],
  ])('透传任何额外的查询参数都不会把它带到页面上', (query) => {
    const html = render({ ...query, name: secret, projectName: secret, owner: secret });

    expect(html).not.toContain(secret);
    expect(html).not.toContain('客户');
  });

  it('编码本身可以出现（它就在访问者自己打开的 URL 里），除此之外不吐任何标识', () => {
    const html = render(PASSWORD_FORM);

    expect(html).toContain('p-z2jo4sob-p01');
    expect(html).not.toMatch(/releases\/\d/);
    expect(html).not.toContain('proto_access_');
  });

  it.each([
    ['from 里塞引号与标签', '/p/crm/"><svg onload=alert(1)>'],
    ['from 里塞换行', '/p/crm/\n<script>alert(1)</script>'],
  ])('%s：进 href 前一律百分号编码，页面上只剩那一条登录链接', (_label, from) => {
    const html = render({ code: '403', reason: 'NEED_LOGIN', from });

    expect(html).not.toContain('onload=alert');
    expect(html).not.toContain('<svg');
    const hrefs = html.match(/href="[^"]*"/g) ?? [];
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toMatch(
      /^href="https:\/\/proto\.example\.com\/auth\/login\?redirect=%2Fp%2Fcrm%2F/,
    );
  });
});

describe('自包含：不引构建产物，也不留破 CSS', () => {
  const forms = [
    PASSWORD_FORM,
    { code: '403', reason: 'NEED_LOGIN', from: '/p/crm/crm-p01/' },
    { code: '403', reason: 'NO_PERMISSION' },
    { code: '404' },
  ];

  it.each(forms)('%o：样式与脚本都在页面里', (query) => {
    const html = render(query);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
  });

  it('内联样式的花括号成对，且规则之间没有游离分号', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(render(PASSWORD_FORM))?.[1] ?? '';

    expect(style.length).toBeGreaterThan(0);
    expect(style.match(/\{/g)?.length).toBe(style.match(/\}/g)?.length);
    expect(style).not.toContain('};');
    expect(style).not.toContain(';;');
  });

  it('密码表单的提交脚本：成功后整页重载，让 nginx 重新走一次 auth_request', () => {
    expect(render(PASSWORD_FORM)).toContain('getElementById("f")');
    expect(render(PASSWORD_FORM)).toContain('window.location.reload()');
  });
});

import type { AccessReason } from '@protohub/shared';
import {
  ACCESS_GATE_CODES,
  ACCESS_REASONS,
  isValidProjectCode,
  isValidPrototypeCode,
} from '@protohub/shared';

/**
 * 门面页的 HTML 渲染（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5.3；
 * [后端接口设计.md](../../../../../docs/后端接口设计.md) §9.3；迭代实施计划 M4-T6）。
 *
 * 三条硬约束决定了这里的写法：
 * 1. **自包含**：受众可能是外部客户，不能引管理台的构建产物（一个 CSS/JS 文件都不引，
 *    样式内联、脚本内联），nginx `error_page` 也要能直接拿到一个 HTML 响应。
 * 2. **不回显业务信息**：页面里只出现"该原型"这类中性措辞——一旦出现项目名/原型名，
 *    任何人拿编码来访问就能确认它存在、还知道它叫什么（§5.3 与 §5.1 统一 404 是同一件事的两面）。
 *    唯一出现的标识是**访问者自己已经在 URL 里给出的那两段编码**，它是解锁表单的提交目标。
 * 3. **状态码只有四种**：这里只渲染 401/403/404 三类形态，其余（包括 `reason` 拼错、
 *    编码不合法）一律退到"链接无效"，不给第五种形态，也不因输入异常而报错。
 *
 * 所以 `renderGatePage()` 是纯函数：入参已经过 `parseGateQuery()` 收敛，不碰请求、不查库。
 */

/** §5.3 表里的那五种形态加上"参数不认"的兜底形态。 */
type GateForm =
  | 'invalid-link'
  | 'need-login'
  | 'no-password'
  | 'no-permission'
  | 'prototype-archived'
  | 'project-archived'
  | 'unavailable';

export interface GateFacts {
  /** 已判定合法的两段编码；不合法时为 null，此时密码形态退化成"链接无效" */
  readonly codes: { projectCode: string; prototypeCode: string } | null;
  /** 登录成功后跳回的站内相对路径（只接受 `/p/` 开头，见 parseGateQuery） */
  readonly from: string | null;
  readonly form: GateForm;
}

/**
 * nginx 透传过来的查询串 → 渲染事实。
 *
 * 每个入参都先验证再用：`code` 必须是那三个数字串、`reason` 必须在 `ACCESS_REASONS` 里、
 * 两段编码必须过 `CODE_RULE`（它们会被拼进表单的 `action`）、`from` 必须是站内 `/p/` 路径
 * （否则就是一个开放重定向）。任何一条不满足都往保守方向退，不抛错。
 */
export function parseGateQuery(query: Record<string, unknown>): GateFacts {
  const code = gateCodeOf(query.code);
  const reason = reasonOf(query.reason);
  const codes = codesOf(query.project, query.prototype);
  let form = formOf(code, reason);
  // 密码形态必须有提交目标：编码不合法就没法拼 `action`，此时给"链接无效"，
  // 而不是一个没有出口的密码输入框。
  if (form === 'no-password' && codes === null) {
    form = 'invalid-link';
  }

  return { codes, form, from: safeReturnPath(query.from) };
}

function gateCodeOf(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return (ACCESS_GATE_CODES as readonly string[]).includes(text) ? text : null;
}

function reasonOf(value: unknown): AccessReason | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return (ACCESS_REASONS as readonly string[]).includes(text)
    ? (text as AccessReason)
    : null;
}

function codesOf(
  project: unknown,
  prototype: unknown,
): GateFacts['codes'] {
  const projectCode = typeof project === 'string' ? project.trim() : '';
  const prototypeCode = typeof prototype === 'string' ? prototype.trim() : '';
  // 与 `/api/access/check` 解析 URI 时用的是同一份判定（shared 的 `CODE_RULE`），
  // 所以"门面页认为合法的编码"与"服务端愿意去查的编码"不会各说一套。
  if (!isValidProjectCode(projectCode) || !isValidPrototypeCode(prototypeCode)) {
    return null;
  }
  return { projectCode, prototypeCode };
}

/**
 * `from` 只接受站内的 `/p/` 路径。
 *
 * 四种写法都会被拒：带 scheme 的绝对地址（`https://evil.example/x`）、协议相对地址
 * （`//evil.example/x`，浏览器会当成另一个站）、含 `..` 的路径（`/p/../admin` 会被浏览器
 * 归一化成 `/admin`，等于把登录后的用户送出原型区）、以及管理台自己的路径（登录后不该被送回
 * 一个需要另一套凭据的地方）。这里没有"猜错就跳转出去"的余地，因为它最终会拼进
 * `{PUBLIC_BASE_URL}/auth/login?redirect=`。
 */
function safeReturnPath(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (
    !text.startsWith('/p/') ||
    text.includes('\\') ||
    text.includes('\0') ||
    text.length > 512 ||
    text.split('/').includes('..')
  ) {
    return null;
  }
  return text;
}

/** 状态码 + 原因 → 形态。与机制 §5.3 那张表逐行对齐。 */
function formOf(code: string | null, reason: AccessReason | null): GateForm {
  if (code === '401') {
    return reason === 'NEED_PASSWORD' || reason === null ? 'no-password' : 'unavailable';
  }
  if (code === '404' || code === null) {
    // 不区分"不存在"与"未发布"（R-9）：这两种在页面上就是同一句话
    return 'invalid-link';
  }
  switch (reason) {
    case 'NEED_LOGIN': {
      return 'need-login';
    }
    case 'NO_PERMISSION': {
      return 'no-permission';
    }
    case 'PROTOTYPE_ARCHIVED': {
      return 'prototype-archived';
    }
    case 'PROJECT_ARCHIVED': {
      return 'project-archived';
    }
    default: {
      // 403 但原因不是那四个（含 reason 缺失/拼错）：给一句中性话，不猜
      return 'unavailable';
    }
  }
}

interface FormCopy {
  readonly description: string;
  readonly hint: string;
  readonly title: string;
}

/**
 * 文案表（计划 M4 的回写项：这五段最终文案以这里为准）。
 * `hint` 是补充说明，`description` 是给"拿到链接却进不来"的人看的正文。
 */
const COPY: Record<GateForm, FormCopy> = {
  'invalid-link': {
    description: '链接无效或已失效。',
    hint: '可能是原型已被删除、编码写错，或这条链接还没有发布过内容。',
    title: '链接无效',
  },
  'need-login': {
    description: '该原型仅限内部成员查看。',
    hint: '登录后即可访问。如果登录以后仍然打不开，说明你还不是该项目的成员。',
    title: '需要登录',
  },
  'no-password': {
    description: '该原型需要访问密码。',
    hint: '密码由原型的所有者提供。输入正确后一天内不必再输。',
    title: '需要访问密码',
  },
  'no-permission': {
    description: '你没有查看该原型的权限。',
    hint: '该原型只对项目成员开放，请联系原型的所有者把你加入项目。',
    title: '没有访问权限',
  },
  'prototype-archived': {
    description: '该原型已下架。',
    hint: '所有者把它撤下了；如果确有需要，请联系他重新发布。',
    title: '原型已下架',
  },
  'project-archived': {
    description: '该原型所属项目已下架。',
    hint: '项目下架期间其下所有原型都不可访问，恢复项目后即可打开。',
    title: '项目已下架',
  },
  unavailable: {
    description: '该原型暂时无法访问。',
    hint: '请稍后重试；如果一直打不开，请把这条链接反馈给原型的所有者。',
    title: '暂时无法访问',
  },
};

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";

/**
 * 渲染门面页。`publicBaseUrl` 只用于拼「去登录」的目标地址（由配置给，代码里不写死），
 * 而密码表单的提交目标是**相对路径**——门面页本身就在 `/p/...` 的 error_page 后面，
 * 相对路径不会把站内地址变成另一个站。
 */
export function renderGatePage(facts: GateFacts, publicBaseUrl: string): string {
  const copy = COPY[facts.form];
  const body =
    facts.form === 'no-password' ? passwordForm(facts) : actions(facts, publicBaseUrl);

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(copy.title)}</title>`,
    `<style>${CSS}</style>`,
    '</head>',
    '<body>',
    '<main class="card">',
    `<h1>${escapeHtml(copy.title)}</h1>`,
    `<p class="lead">${escapeHtml(copy.description)}</p>`,
    `<p class="hint">${escapeHtml(copy.hint)}</p>`,
    body,
    '<p class="foot">ProtoHub</p>',
    '</main>',
    SCRIPT,
    '</body>',
    '</html>',
  ].join('\n');
}

function actions(facts: GateFacts, publicBaseUrl: string): string {
  if (facts.form !== 'need-login') {
    return '';
  }
  const redirect = facts.from === null ? '' : `?redirect=${encodeURIComponent(facts.from)}`;
  const loginUrl = `${publicBaseUrl.replace(/\/+$/, '')}/auth/login${redirect}`;
  return `<a class="btn" href="${escapeHtml(loginUrl)}">去登录</a>`;
}

function passwordForm(facts: GateFacts): string {
  const codes = facts.codes;
  if (codes === null) {
    // 编码不合法就没法拼提交目标；退化成"链接无效"由调用方的 formOf 保证不会走到这里，
    // 但表单的 action 是这段唯一的注入点，宁可在这里也判一次。
    return '';
  }
  const action = `/api/access/${encodeURIComponent(codes.projectCode)}/${encodeURIComponent(codes.prototypeCode)}/unlock`;
  return [
    `<form id="f" action="${escapeHtml(action)}" method="post" autocomplete="off">`,
    '<label for="p">访问密码</label>',
    '<input id="p" name="password" type="password" required maxlength="64" autocomplete="current-password">',
    '<button class="btn" type="submit">进入</button>',
    '<p id="m" class="msg" role="status" aria-live="polite"></p>',
    '</form>',
  ].join('\n');
}

/**
 * 只做一件事：把表单改成 `fetch` 提交（成功后整页重载，让 nginx 重新走一次 auth_request），
 * 并把失败翻成人话。没有框架、没有外部文件。
 */
const SCRIPT = [
  '<script>',
  '(function () {',
  '  var form = document.getElementById("f");',
  '  if (!form) { return; }',
  '  form.addEventListener("submit", function (event) {',
  '    event.preventDefault();',
  '    var button = form.querySelector("button");',
  '    var message = document.getElementById("m");',
  '    var password = form.password ? form.password.value : "";',
  '    if (button) { button.disabled = true; }',
  '    if (message) { message.textContent = ""; }',
  '    fetch(form.action, {',
  '      method: "POST",',
  '      headers: { "Content-Type": "application/json" },',
  '      body: JSON.stringify({ password: password }),',
  '      credentials: "same-origin"',
  '    }).then(function (response) {',
  '      return response.json().catch(function () { return {}; });',
  '    }).then(function (payload) {',
  '      if (payload && payload.code === 0) { window.location.reload(); return; }',
  '      if (button) { button.disabled = false; }',
  '      if (message) { message.textContent = (payload && payload.error) || "密码不对，请再试一次"; }',
  '    }).catch(function () {',
  '      if (button) { button.disabled = false; }',
  '      if (message) { message.textContent = "提交失败，请稍后重试"; }',
  '    });',
  '  });',
  '})();',
  '</script>',
].join('\n');

const CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0}',
  `body{background:#f5f6f8;color:#1c1f23;display:flex;font-family:${FONT_STACK};`,
  '  justify-content:center;min-height:100vh;padding:24px}',
  'main{background:#fff;border:1px solid #e3e6ea;border-radius:12px;max-width:26rem;',
  '  padding:2rem 1.75rem;text-align:center;width:100%;margin-top:8vh}',
  'h1{font-size:1.15rem;line-height:1.5;margin:0 0 .75rem;font-weight:600}',
  'p{margin:0 0 .5rem;line-height:1.7}',
  '.lead{font-size:1rem}',
  '.hint{color:#6b7280;font-size:.8125rem;margin-bottom:1.5rem}',
  'label{display:block;font-size:.8125rem;margin-bottom:.375rem;text-align:left;color:#3c4147}',
  'input{border:1px solid #d4d8dd;border-radius:8px;font:inherit;padding:.55rem .7rem;',
  '  margin:0 auto .75rem;width:100%;max-width:16rem}',
  'input:focus{border-color:#2f6feb;outline:2px solid rgba(47,111,235,.25)}',
  '.btn{background:#2f6feb;border-radius:8px;color:#fff;display:inline-block;font:inherit;',
  '  padding:.5rem 1.25rem;text-decoration:none;border:0;cursor:pointer}',
  '.btn:hover{background:#2b62d6}',
  '.btn[disabled]{opacity:.6;cursor:progress}',
  '.msg{color:#b3261e;font-size:.8125rem;margin-top:.75rem;min-height:1.2em}',
  '.foot{color:#b3b8bf;font-size:.75rem;margin:1.75rem 0 0}',
].join('');

/** 只用于文本节点与属性值：这里没有模板拼接用户输入之外的地方。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

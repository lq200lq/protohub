import type { AccessLogDevice } from '@protohub/shared';

/**
 * User-Agent 解析（[原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §6；
 * 迭代实施计划 M4-T9）。
 *
 * 为什么自写正则而不是装 `ua-parser-js`：计划 §3.2 的依赖白名单里没有它，为四个字段的展示值
 * 引一个包（还要跟版本升级）不划算。这里要的只是 §6.1 列表里那行 `Chrome 141` / `macOS` 的**可读标签**，
 * 不是精确指纹——判据（`is_bot`、device 分类）也只需要 UA 里那几个稳定 token。
 *
 * 全部是纯函数：给定 UA 出定值，`proto_access_log` 的四个派生列（browser/os/device/is_bot）
 * 因此可以在单测里逐条钉住，不需要真实浏览器。
 */
export interface UaInfo {
  readonly browser: null | string;
  /** `null`=不知道（没带 UA）。有 UA 时四种取值之一，包括 `bot`。 */
  readonly device: AccessLogDevice | null;
  readonly isBot: boolean;
  readonly os: null | string;
}

/**
 * 机制 §6 原话的六个标识（大小写不敏感）。命中就 `is_bot`：记录**保留**但不计入 UV，
 * 于是"链接被放进公开群被爬"这件事在 `botPv` 里看得见，又不会污染 UV。
 */
const BOT_TOKENS = /bot|crawler|spider|curl|wget|headless/i;

/**
 * 顺序即优先级：Chromium 系的 UA 里同时出现 `Safari/537.36`，Edge 里又同时出现 `Chrome/`，
 * 反过来排会把 Edge 认成 Chrome。iOS 上的各家浏览器用的是另一套 token（`FxiOS`/`CriOS`/`EdgiOS`）。
 *
 * Safari 那条要用 `.*` 跨过中间的 token：iOS 上的 Safari UA 是
 * `Version/17.5 Mobile/15E148 Safari/604.1`，`Version/` 与 `Safari/` 之间隔着手机标记，
 * 挨着写的正则会在 iPhone 上什么都匹配不到（Chromium 系没有 `Version/`，所以不会误判成 Safari）。
 */
const BROWSER_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Edge', /(?:EdgA|EdgiOS|Edg)\/(\d+)/i],
  ['Opera', /(?:OPR|OPiOS)\/(\d+)/i],
  ['Firefox', /(?:FxiOS|Firefox)\/(\d+)/i],
  ['Chrome', /(?:CriOS|Chrome|Chromium)\/(\d+)/i],
  ['Safari', /Version\/(\d+).*Safari\/\d/i],
];

/**
 * `Windows NT x.y` → 产品名。`10.0` 同时覆盖 Win10 与 Win11（微软为了兼容把两个版本的
 * NT 号都留在 10.0，UA 里分不出来），所以这里诚实地写 `Windows 10/11` 而不是编一个 11。
 */
const WINDOWS_NT_NAMES: Readonly<Record<string, string>> = {
  '10.0': 'Windows 10/11',
  '6.3': 'Windows 8.1',
  '6.2': 'Windows 8',
  '6.1': 'Windows 7',
};

function browserOf(userAgent: string): null | string {
  for (const [label, pattern] of BROWSER_PATTERNS) {
    const match = pattern.exec(userAgent);
    if (match) {
      // 只取主版本号（§6.1 的展示口径就是 `Chrome 141`）：完整四段版本对患者没用。
      const major = match[1];
      return major === undefined ? label : `${label} ${major}`;
    }
  }
  return null;
}

function osOf(userAgent: string): null | string {
  const windows = /Windows NT ([\d.]+)/i.exec(userAgent);
  if (windows) {
    const named = windows[1] === undefined ? undefined : WINDOWS_NT_NAMES[windows[1]];
    return named ?? 'Windows';
  }
  // iOS 的版本在 `CPU iPhone OS 17_5_1 like Mac OS X` 里，iPad 是 `CPU OS 17_5_1`（不带 iPhone），
  // 下划线要换成点。整段必须以 `CPU ` 起头，否则会撞上 macOS 的 `Mac OS X`。
  const appleMobile = /CPU (?:iPhone )?OS ([\d._]+)/i.exec(userAgent);
  if (appleMobile?.[1] && /iPhone|iPad|iPod/.test(userAgent)) {
    const version = appleMobile[1].replaceAll('_', '.').replace(/\.$/, '');
    return `${userAgent.includes('iPad') ? 'iPadOS' : 'iOS'} ${version}`;
  }
  const android = /Android ([\d.]+)/i.exec(userAgent);
  if (android) {
    return android[1] === undefined ? 'Android' : `Android ${android[1]}`;
  }
  // macOS 只能给到名字：Big Sur 起 UA 冻结在 `Mac OS X 10_15_7`（所有版本都一样），
  // 真实大版本要读 User-Agent Client Hints，一期不做——写个假版本号比写空更糟。
  if (/Macintosh|Mac OS X/i.test(userAgent)) {
    return 'macOS';
  }
  // 放在 Android 之后：Android 的 UA 里也带 `Linux`。
  if (/Linux|X11/i.test(userAgent)) {
    return 'Linux';
  }
  return null;
}

/**
 * 设备分类。Android 的**手机** UA 带 `Mobile`、**平板**不带（业界据此区分多年的规则），
 * 而 iPad 在 iPadOS 13+ 默认伪装成 Macintosh——那只能靠多指触控的 Client Hints 区分，
 * 一期按 `desktop` 记，代价是平板的 UV 归到桌面，不影响任何访问控制。
 */
function deviceOf(userAgent: string, isBot: boolean): AccessLogDevice {
  if (isBot) {
    return 'bot';
  }
  if (/iPad|Tablet|PlayBook|Kindle|Silk/i.test(userAgent)) {
    return 'tablet';
  }
  if (/Android/i.test(userAgent)) {
    return /Mobile/i.test(userAgent) ? 'mobile' : 'tablet';
  }
  if (/iPhone|iPod|Windows Phone|Opera Mini|Mobile/i.test(userAgent)) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * 输入是 `userAgentOf()` 裁剪过的原始 UA（可为 null：curl 不带 UA）。
 * 拿不到 UA 时四个字段给"不知道"而不是猜一个 `desktop`——`is_bot` 猜错会把爬虫算进 UV，
 * 而 `device` 为空在列表页只是一个空白单元格。
 */
export function parseUserAgent(userAgent: null | string): UaInfo {
  if (userAgent === null || userAgent === '') {
    return { browser: null, device: null, isBot: false, os: null };
  }
  const isBot = BOT_TOKENS.test(userAgent);
  return {
    browser: browserOf(userAgent),
    device: deviceOf(userAgent, isBot),
    isBot,
    os: osOf(userAgent),
  };
}

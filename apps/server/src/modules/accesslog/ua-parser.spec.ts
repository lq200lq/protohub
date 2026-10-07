import { describe, expect, it } from 'vitest';

import { parseUserAgent } from './ua-parser';

/**
 * UA 解析（迭代实施计划 M4-T9）。
 *
 * 全部用**真实 UA 字符串**（各浏览器实际发出的形状），而不是自己拼的假串——这个模块的价值
 * 恰恰在于"真实 UA 长什么样"，写一个符合想象的串只会把正则钉死在想象上。
 * 展示值的口径来自机制 §6.1（`Chrome 141` / `macOS` 这种粒度）。
 */
const UA = {
  androidChromePhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidChromeTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  baiduspider:
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  curl: 'curl/8.7.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3595.2',
  firefoxEs:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  googlebot:
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  headlessChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7399.0 Safari/537.36',
  ipadSafari:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7399.0 Mobile/15E148 Safari/604.1',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/116.0.0.0',
  nakedMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  win7IE: 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)',
} as const;

describe('浏览器标签', () => {
  it.each([
    ['Chrome', UA.chromeWindows, 'Chrome 141'],
    ['Edge（UA 里同时带 Chrome/）', UA.edgeWindows, 'Edge 141'],
    ['Opera', UA.operaWindows, 'Opera 116'],
    ['Firefox', UA.firefoxEs, 'Firefox 132'],
    ['macOS Safari', UA.macSafari, 'Safari 17'],
    ['iOS Safari（Version/ 与 Safari/ 之间隔着 Mobile/）', UA.iphoneSafari, 'Safari 17'],
    ['iOS 上的 Chrome（CriOS）', UA.iphoneChrome, 'Chrome 141'],
  ] as const)('%s → %s', (_label, userAgent, expected) => {
    expect(parseUserAgent(userAgent).browser).toBe(expected);
  });

  it('认不出来的浏览器给 null，不硬套一个 Chrome', () => {
    expect(parseUserAgent(UA.nakedMac).browser).toBeNull();
    expect(parseUserAgent(UA.win7IE).browser).toBeNull();
  });
});

describe('操作系统标签', () => {
  it.each([
    ['Windows 10/11（NT 10.0 分不出两代）', UA.chromeWindows, 'Windows 10/11'],
    ['Windows 7', UA.win7IE, 'Windows 7'],
    ['macOS 不带版本号（UA 冻结在 10_15_7）', UA.macSafari, 'macOS'],
    ['iPhone', UA.iphoneSafari, 'iOS 17.5.1'],
    ['iPad（UA 里是 CPU OS，没有 iPhone 字样）', UA.ipadSafari, 'iPadOS 17.5'],
    ['Android', UA.androidChromePhone, 'Android 14'],
    ['Linux 桌面', UA.linuxChrome, 'Linux'],
  ] as const)('%s → %s', (_label, userAgent, expected) => {
    expect(parseUserAgent(userAgent).os).toBe(expected);
  });

  it('Googlebot 的 UA 里没有操作系统，就别猜一个', () => {
    expect(parseUserAgent(UA.googlebot).os).toBeNull();
  });
});

describe('设备分类', () => {
  it.each([
    ['桌面 Chrome', UA.chromeWindows, 'desktop'],
    ['iPhone', UA.iphoneSafari, 'mobile'],
    ['Android 手机（带 Mobile）', UA.androidChromePhone, 'mobile'],
    ['Android 平板（不带 Mobile）', UA.androidChromeTablet, 'tablet'],
    ['iPad', UA.ipadSafari, 'tablet'],
  ] as const)('%s → %s', (_label, userAgent, expected) => {
    expect(parseUserAgent(userAgent).device).toBe(expected);
  });
});

describe('爬虫判定（机制 §6：记录保留但不进 UV）', () => {
  it.each([
    ['curl', UA.curl],
    ['Googlebot', UA.googlebot],
    ['Baiduspider（UA 里同时是 Android Chrome）', UA.baiduspider],
    ['HeadlessChrome', UA.headlessChrome],
  ] as const)('%s → is_bot', (_label, userAgent) => {
    expect(parseUserAgent(userAgent).isBot).toBe(true);
    expect(parseUserAgent(userAgent).device).toBe('bot');
  });

  it('bot 的优先级高于设备：爬虫伪装成手机也算 bot', () => {
    expect(parseUserAgent(UA.baiduspider).device).toBe('bot');
  });

  it('HeadlessChrome 认得出浏览器名，但照样算 bot（是自动化不是真人）', () => {
    const info = parseUserAgent(UA.headlessChrome);
    expect(info.browser).toBe('Chrome 141');
    expect(info.isBot).toBe(true);
  });

  it.each([
    [UA.chromeWindows],
    [UA.iphoneSafari],
    [UA.macSafari],
  ] as const)('真人浏览器不该被误判成 bot：%s', (userAgent) => {
    expect(parseUserAgent(userAgent).isBot).toBe(false);
  });
});

describe('没有 UA 时一律"不知道"', () => {
  /** curl 不带 `-A`、以及被剥掉 UA 的请求都走这里：猜一个 desktop 会让 UV 多算一个不存在的人。 */
  it.each([[null], ['']])('%s → 四个字段全空', (userAgent) => {
    expect(parseUserAgent(userAgent)).toEqual({
      browser: null,
      device: null,
      isBot: false,
      os: null,
    });
  });
});

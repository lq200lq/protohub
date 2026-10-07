import { Injectable } from '@nestjs/common';

import { readRequestHeader, type HttpRequestLike } from '../../common/http-types';
import { clientIpOf, userAgentOf } from '../auth/client-request';
import { type AccessLogRow } from './access-log.repo';
import { AccessLogBufferService } from './access-log.buffer.service';
import { accessLogResultOf } from './record-policy';
import { parseUserAgent } from './ua-parser';

/**
 * 一次访问的输入（三个入口都往这里送；口径本身不在这，见 `record-policy.ts`）。
 *
 * `request` 只用到 `headers`/`ip`（`clientIpOf` 那一串回落），传输层类型不外溢。
 * 三个 id 由**决策**给：编码不存在时它们就是 null，这正是 §6.1「无效链接」行的数据来源。
 */
export interface AccessVisit {
  /** 原始 URI（`/p/crm/crm-p01/assets/app.js?x=1`）；入库只取 `?` 之前的路径部分。 */
  readonly uri: string;
  readonly isEntry: boolean;
  readonly projectCode: string;
  readonly prototypeCode: string;
  readonly request: HttpRequestLike & { readonly ip?: string };
  readonly status: number;
  readonly prototypeId?: null | string;
  readonly releaseId?: null | string;
  readonly userId?: null | string;
}

/** `proto_access_log` 的列宽（数据库设计 §4.2.7）。超长不报错而是裁：统计列不值得让一次写入失败。 */
const MAX_ROUTE_KEY = 140;
const MAX_PATH = 500;
const MAX_UA = 500;
const MAX_REFERER = 500;
const MAX_BROWSER = 40;
const MAX_OS = 40;
const MAX_DEVICE = 20;

function clip(value: null | string | undefined, max: number): null | string {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

/** id 一律是决策给出来的字符串；不是纯数字就当没有（`bigint` 列塞脏值会让整批插入失败）。 */
function toBigInt(value: null | string | undefined): bigint | null {
  if (value !== undefined && value !== null && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/** 查询串不进 `path`：链接里可能带临时 token，而统计只需要"哪个文件"。 */
function pathOnly(uri: string): string {
  const index = uri.indexOf('?');
  const withoutQuery = index === -1 ? uri : uri.slice(0, index);
  const hash = withoutQuery.indexOf('#');
  return hash === -1 ? withoutQuery : withoutQuery.slice(0, hash);
}

/**
 * 访问记录的录入口（机制 §6；迭代实施计划 M4-T9）。
 *
 * 三个调用点（`/api/access/check`、`/api/access/gate`、Node 直出路由）都只做一件事：
 * 把手上那次判定原样交过来。这里负责**换成行的形状**（口径 → UA/IP → 列宽裁剪）再交给缓冲。
 *
 * `record()` 刻意是同步 `void` 且整体 try/catch：静态访问的关键路径上不允许出现"因为要记日志
 * 所以可能抛"（F-17）。构造行失败就丢掉这条记录并留本地 warn，与写库失败同一个处理。
 */
@Injectable()
export class AccessLogRecorderService {
  constructor(private readonly buffer: AccessLogBufferService) {}

  record(visit: AccessVisit): void {
    const result = accessLogResultOf({ isEntry: visit.isEntry, status: visit.status });
    if (result === null) {
      return;
    }
    // 没有两级编码就没有可归属的 `route_key`（这一列 NOT NULL），这种请求不记。
    if (visit.projectCode === '' || visit.prototypeCode === '') {
      return;
    }
    try {
      this.buffer.enqueue(this.toRow(visit, result));
    } catch {
      // 到这里只剩"构造行"失败一种可能（写库失败在缓冲层里已经被吞掉）。
      return;
    }
  }

  private toRow(visit: AccessVisit, result: string): AccessLogRow {
    const userAgent = clip(userAgentOf(visit.request), MAX_UA);
    const info = parseUserAgent(userAgent);
    return {
      browser: clip(info.browser, MAX_BROWSER),
      // 请求时间，不是写入时间：批量写最多滞后 2 秒，跨过日界线会把访问算到第二天。
      createdAt: new Date(),
      device: clip(info.device, MAX_DEVICE),
      // 以 nginx 写的 `X-Real-IP` 为准（机制 §6：XFF 可伪造）。`clientIpOf` 的回落顺序正是
      // X-Real-IP → XFF → socket，直连开发时第三档才是真来源。
      ip: clientIpOf(visit.request),
      isBot: info.isBot,
      os: clip(info.os, MAX_OS),
      path: pathOnly(visit.uri).slice(0, MAX_PATH),
      prototypeId: toBigInt(visit.prototypeId),
      referer: clip(readRequestHeader(visit.request, 'referer'), MAX_REFERER),
      releaseId: toBigInt(visit.releaseId),
      result,
      routeKey: `${visit.projectCode}/${visit.prototypeCode}`.slice(0, MAX_ROUTE_KEY),
      ua: userAgent,
      userId: toBigInt(visit.userId),
    };
  }
}

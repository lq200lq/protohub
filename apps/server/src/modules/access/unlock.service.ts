import { Injectable } from '@nestjs/common';
import { verify as verifyArgon2 } from 'argon2';

import { accessCookieName } from '../../common/permission/cookie.service';
import { PROTO_ACCESS_PREFIX } from '../../config/constants';
import { AccessRepo } from './access.repo';
import type { AccessReason } from './decide-access';
import { AccessService } from './access.service';
import { UnlockTokenService } from './unlock-token.service';
import { unlockAttemptKey, UnlockRateLimiter } from './unlock-rate-limiter.service';

/**
 * 密码档解锁（[后端接口设计.md](../../../../../docs/后端接口设计.md) §9.2、
 * [原型发布与访问机制.md](../../../../../docs/原型发布与访问机制.md) §5.2；迭代实施计划 M4-T7）。
 *
 * 三条不显然的做法：
 *
 * 1. **状态判定不自己拼**：进门先跑一遍 `AccessService.decide()`（凭据全空），拿到的就是
 *    `/api/access/check` 与直出入口同一份结论——归档/未发布/不存在/member 档各自给什么码，
 *    这里不可能与那条链接给出第二个答案（决策 D-05）。只有结论是 `NEED_PASSWORD` 时才继续。
 * 2. **限速键用编码而不是原型 ID**：锁定必须在**任何库查询之前**判定才有意义（否则爆破者每试一次
 *    都换一次 DB 开销），而键要的是"这次请求打的是哪个原型"——URL 里的两段编码就够了，ID 在行里。
 *    同码软删重建会共用一个计数桶，方向是偏严（多锁一会儿），不是偏松。
 * 3. **成功后重置计数**：与登录那侧一致——"连续失败 5 次"里的"连续"要有个终点，否则一个办公室
 *    里前四个人输错、第五个人输对，第五个人仍会被前面积累的次数锁住。
 */

export interface UnlockRequest {
  readonly ip: string | null;
  readonly password: string;
  readonly projectCode: string;
  readonly prototypeCode: string;
}

/** 传输层（控制器）按这个判别式决定状态码、要不要下 Cookie，服务层不碰 reply。 */
export type UnlockResult =
  /** 已经放行：public 档（不需要密码），或这一行刚被改成别的模式。不下 Cookie，因为没东西可下。 */
  | { kind: 'already-open' }
  /** 密码不对（含库里没有哈希、哈希是坏值）：一种答案，不给探测者区分"没设密码"与"密码错"的机会 */
  | { kind: 'bad-password' }
  | { kind: 'denied'; reason: AccessReason; status: 403 | 404 }
  | {
      kind: 'unlocked';
      readonly cookieName: string;
      /** Cookie 的 Path：`/p/{项目编码}/{原型编码}`，只在该原型路径下携带（机制 §5.2）。 */
      readonly cookiePath: string;
      readonly cookieValue: string;
      readonly maxAgeSeconds: number;
    };

/**
 * 验 argon2 哈希。库里存的是明文/截断值时 `verify` 会抛（`Invalid hash`），
 * 一律按"密码不对"处理：这条链路上没有值得告诉访问者的第二种失败。
 */
async function passwordMatches(hash: string | null, password: string): Promise<boolean> {
  if (hash === null || password === '') {
    return false;
  }
  try {
    return await verifyArgon2(hash, password);
  } catch {
    return false;
  }
}

@Injectable()
export class UnlockService {
  constructor(
    private readonly accessRepo: AccessRepo,
    private readonly accessService: AccessService,
    private readonly limiter: UnlockRateLimiter,
    private readonly tokens: UnlockTokenService,
  ) {}

  async unlock(request: UnlockRequest): Promise<UnlockResult> {
    const key = unlockAttemptKey(request);
    // 锁在一切开销之前：判锁是 O(1) 内存查表，被锁住的请求连库都不碰。
    this.limiter.assertNotLocked(key);

    // 凭据全空的判定：唯一可能给出的"要继续"结论是 NEED_PASSWORD，其余都到此为止。
    const outcome = await this.accessService.decide({
      projectCode: request.projectCode,
      prototypeCode: request.prototypeCode,
      readCookie: () => undefined,
    });
    if (outcome.decision.status !== 401) {
      return outcome.decision.status === 200
        ? { kind: 'already-open' }
        : {
            kind: 'denied',
            reason: outcome.decision.reason ?? 'NOT_FOUND',
            status: outcome.decision.status,
          };
    }
    if (outcome.prototypeId === null) {
      // 决策说要密码却拿不到原型 ID：与 check 同口径收敛成 404，不给第五种状态码。
      return { kind: 'denied', reason: 'NOT_FOUND', status: 404 };
    }

    const row = await this.accessRepo.findUnlockRow(outcome.prototypeId);
    if (row === null) {
      return { kind: 'denied', reason: 'NOT_FOUND', status: 404 };
    }
    if (!(await passwordMatches(row.passwordHash, request.password))) {
      this.limiter.recordFailure(key);
      return { kind: 'bad-password' };
    }

    this.limiter.recordSuccess(key);
    return {
      cookieName: accessCookieName(row.id),
      cookiePath: `${PROTO_ACCESS_PREFIX}/${request.projectCode}/${request.prototypeCode}`,
      cookieValue: this.tokens.issue({
        policyVersion: row.policyVersion,
        projectCode: request.projectCode,
        prototypeCode: request.prototypeCode,
      }),
      maxAgeSeconds: this.tokens.ttlSeconds,
      kind: 'unlocked',
    };
  }
}

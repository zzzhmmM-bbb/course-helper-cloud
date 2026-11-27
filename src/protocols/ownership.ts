import { safeEqual } from '../crypto.js';
import type {
  OwnershipVerifyResult,
  PlatformType,
  RainClassroomServerType,
  StoredAccount,
} from '../types.js';
import { ChaoXingClient } from './chaoxing.js';
import { RainClassroomClient } from './rainclassroom.js';

export interface OwnershipVerifyInput {
  accountKey: string;
  platform: PlatformType;
  server: RainClassroomServerType;
  uid: string;
  cookies: Record<string, string>;
  existingAccount: StoredAccount | null;
}

export type OwnershipVerifier = (
  input: OwnershipVerifyInput
) => Promise<OwnershipVerifyResult>;

/**
 * 计算服务端规范化的 accountKey，严禁客户端用任意 accountKey 搭配自己的 uid 越权绑定。
 */
export function buildCanonicalAccountKey(
  platform: PlatformType,
  server: RainClassroomServerType,
  uid: string
): string {
  const cleanUid = String(uid ?? '').trim();
  if (!cleanUid) return '';
  if (platform === 'rainClassroom') {
    return `rc:${server}_${cleanUid}`;
  }
  return `cx:${cleanUid}`;
}

export function isCanonicalAccountKeyMatch(
  accountKey: string,
  platform: PlatformType,
  server: RainClassroomServerType,
  uid: string
): boolean {
  const expected = buildCanonicalAccountKey(platform, server, uid);
  return expected.length > 0 && accountKey.trim() === expected;
}

/**
 * 检查学习通 Cookie 中的 UID 与 _uid 不存在互相冲突且均匹配 expectedUid。
 */
export function hasConsistentChaoXingUid(
  cookies: Record<string, string>,
  expectedUid: string
): boolean {
  const claimed = String(expectedUid ?? '').trim();
  if (!claimed) return false;
  const uidVal = String(cookies.UID ?? '').trim();
  const underUidVal = String(cookies._uid ?? '').trim();
  if (!uidVal && !underUidVal) return false;
  if (uidVal && uidVal !== claimed) return false;
  if (underUidVal && underUidVal !== claimed) return false;
  return true;
}

/**
 * 零网络快速通道：若云端已有有效登录态，且新设备上传的核心会话令牌与云端完全一致，直接判定归属通过。
 */
export function matchesStoredSessionToken(
  platform: PlatformType,
  uid: string,
  incoming: Record<string, string>,
  existing: StoredAccount | null
): boolean {
  if (!existing || existing.sessionStatus !== 'ok') return false;
  if (existing.platform !== platform) return false;
  if (String(existing.uid) !== String(uid)) return false;

  if (platform === 'rainClassroom') {
    const incSid = (incoming.sessionid ?? '').trim();
    const curSid = (existing.cookies.sessionid ?? '').trim();
    return incSid.length >= 8 && curSid.length >= 8 && safeEqual(incSid, curSid);
  }

  if (!hasConsistentChaoXingUid(incoming, uid)) return false;
  const incVc3 = (incoming.vc3 ?? '').trim();
  const curVc3 = (existing.cookies.vc3 ?? '').trim();
  const incD = (incoming._d ?? '').trim();
  const curD = (existing.cookies._d ?? '').trim();
  if (incVc3.length >= 8 && curVc3.length >= 8 && safeEqual(incVc3, curVc3)) {
    return true;
  }
  if (incD.length >= 6 && curD.length >= 6 && safeEqual(incD, curD)) {
    const incUf = (incoming.uf ?? '').trim();
    const curUf = (existing.cookies.uf ?? '').trim();
    return incUf.length >= 8 && curUf.length >= 8 && safeEqual(incUf, curUf);
  }
  return false;
}

export const defaultOwnershipVerifier: OwnershipVerifier = async (
  input
): Promise<OwnershipVerifyResult> => {
  const { accountKey, platform, server, uid, cookies, existingAccount } = input;

  if (!isCanonicalAccountKeyMatch(accountKey, platform, server, uid)) {
    return { ok: false, expired: false, reason: 'accountKey 与账号标识不匹配' };
  }

  if (existingAccount) {
    if (
      existingAccount.platform !== platform ||
      String(existingAccount.uid) !== String(uid) ||
      (existingAccount.platform === 'rainClassroom' &&
        existingAccount.server !== server)
    ) {
      return { ok: false, expired: false, reason: '目标账号元信息不一致' };
    }
  }

  if (matchesStoredSessionToken(platform, uid, cookies, existingAccount)) {
    return { ok: true, actualUid: uid };
  }

  const tempAccount: StoredAccount = {
    accountKey,
    platform,
    server,
    uid,
    name: existingAccount?.name ?? uid,
    cookies,
    cookiesUpdatedAt: Date.now(),
    deviceInfo: existingAccount?.deviceInfo ?? {},
    semesterStartMonday: existingAccount?.semesterStartMonday ?? null,
    timetable: [],
    reservations: [],
    courseLocations: {},
    aiConfig: null,
    configRev: existingAccount?.configRev ?? 1,
    configUpdatedAt: '',
    lastEditorDeviceId: '',
    sessionStatus: 'ok',
    sessionError: '',
    updatedAt: '',
  };

  if (platform === 'rainClassroom') {
    const client = new RainClassroomClient(tempAccount);
    return client.verifyOwnership(uid);
  }

  const client = new ChaoXingClient(tempAccount);
  return client.verifyOwnership(uid);
};

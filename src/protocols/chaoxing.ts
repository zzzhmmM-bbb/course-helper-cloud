import {
  buildCxLocationResultJson,
  buildCxUserAgent,
  getCxDeviceCode,
  getCxEncParams,
  getUniqueId,
} from '../crypto.js';
import type {
  OnlineCourse,
  OwnershipVerifyResult,
  StoredAccount,
} from '../types.js';
import { SessionExpiredError } from './rainclassroom.js';

export interface CxActiveItem {
  id: string;
  name: string;
  activeType: number; // 2 = signIn, 74 = scheduledSignIn
  status: number; // 1 = ongoing
  otherId: number; // 0 = normal/photo, 2 = qr, 3 = gesture, 4 = location, 5 = code
  url: string;
}

export interface CxActiveDetail {
  otherId: number;
  needPhoto: boolean;
  needFace: boolean;
  needCaptcha: boolean;
  locationLat: number | null;
  locationLng: number | null;
  locationText: string | null;
  locationRange: number | null;
  raw: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class ChaoXingClient {
  private readonly uniqueId = getUniqueId();
  private readonly userAgent: string;
  private readonly cookies: Record<string, string>;

  constructor(
    private readonly account: StoredAccount,
    private readonly onCookiesUpdated?: (cookies: Record<string, string>) => void
  ) {
    this.userAgent = buildCxUserAgent(this.uniqueId);
    this.cookies = { ...account.cookies };
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cookieStr = Object.entries(this.cookies)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Accept-Language': 'zh_CN',
      Connection: 'keep-alive',
    };
    if (cookieStr) {
      headers.Cookie = cookieStr;
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  private mergeSetCookies(response: Response): void {
    const getSetCookie = (
      response.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie;
    const setCookies = typeof getSetCookie === 'function'
      ? getSetCookie.call(response.headers)
      : [];
    if (!setCookies.length) return;
    const delta: Record<string, string> = {};
    let changed = false;
    for (const rawHeader of setCookies) {
      const firstPart = rawHeader.split(';')[0] ?? '';
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      if (key && this.cookies[key] !== val) {
        this.cookies[key] = val;
        delta[key] = val;
        changed = true;
      }
    }
    if (changed && this.onCookiesUpdated) {
      this.onCookiesUpdated(delta);
    }
  }

  private async request(
    url: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string>;
      formBody?: Record<string, string>;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<{ status: number; text: string }> {
    const targetUrl = new URL(url);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        targetUrl.searchParams.set(k, v);
      }
    }

    const method = options.method ?? 'GET';
    const headers = this.buildHeaders(options.headers);
    let bodyStr: string | undefined;
    if (options.formBody) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      bodyStr = new URLSearchParams(options.formBody).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 15000
    );
    try {
      const resp = await fetch(targetUrl.toString(), {
        method,
        headers,
        body: bodyStr,
        redirect: 'manual',
        signal: controller.signal,
      });
      this.mergeSetCookies(resp);

      if (resp.status === 401 || resp.status === 403) {
        throw new SessionExpiredError(
          `学习通登录态已过期 (HTTP ${resp.status})`
        );
      }
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') ?? '';
        if (loc.includes('passport2.chaoxing.com/login')) {
          throw new SessionExpiredError('学习通 Cookie 已失效，需重新登录');
        }
      }

      const text = await resp.text();
      if (
        text.includes('passport2.chaoxing.com/login') ||
        text.includes('请先登录')
      ) {
        throw new SessionExpiredError('学习通 Cookie 已失效，需重新登录');
      }
      return { status: resp.status, text };
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestJson(
    url: string,
    options: {
      method?: 'GET' | 'POST';
      params?: Record<string, string>;
      formBody?: Record<string, string>;
      headers?: Record<string, string>;
      timeoutMs?: number;
    } = {}
  ): Promise<Record<string, unknown> | null> {
    const { text } = await this.request(url, options);
    if (!text.trim()) return null;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /**
   * 严格校验证明学习通 Cookie 真实有效且归属于 expectedUid。
   * 1) 先核对 Cookie 内 UID/_uid 字段严格匹配 expectedUid；
   * 2) 优先通过 sso userLogin4Uname.do GET 核验返回 msg.puid === expectedUid；
   * 3) 若该接口未返回 puid 且未过期，则回退校验 backclazzdata（超星服务端会对 UID+uf/_d/vc3 验签）。
   */
  async verifyOwnership(expectedUid: string): Promise<OwnershipVerifyResult> {
    const claimed = String(expectedUid ?? '').trim();
    if (!claimed) {
      return { ok: false, expired: false, reason: '缺少目标 UID' };
    }
    const uidVal = String(this.cookies.UID ?? '').trim();
    const underUidVal = String(this.cookies._uid ?? '').trim();
    if (!uidVal && !underUidVal) {
      return { ok: false, expired: true, reason: '学习通 Cookie 缺少 UID' };
    }
    if ((uidVal && uidVal !== claimed) || (underUidVal && underUidVal !== claimed)) {
      return {
        ok: false,
        expired: false,
        actualUid: underUidVal || uidVal,
        reason: '学习通 Cookie 中的 UID/_uid 与目标账号不一致',
      };
    }
    try {
      const sso = await this.requestJson(
        'https://sso.chaoxing.com/apis/login/userLogin4Uname.do',
        { timeoutMs: 10000 }
      );
      if (sso && Number(sso.result) === 1) {
        const msg = asRecord(sso.msg);
        const puid = msg?.puid !== undefined && msg?.puid !== null
          ? String(msg.puid).trim()
          : '';
        if (puid) {
          if (puid !== claimed) {
            return {
              ok: false,
              expired: false,
              actualUid: puid,
              reason: '学习通 SSO 返回的 puid 与目标账号不一致',
            };
          }
          return { ok: true, actualUid: puid };
        }
      }

      // 回退校验前强制要求 _uid === claimed，彻底杜绝 UID/_uid 分裂绕过
      if (underUidVal !== claimed) {
        return {
          ok: false,
          expired: true,
          reason: '学习通 Cookie 缺少与账号一致的 _uid 凭证',
        };
      }
      const clazz = await this.requestJson(
        'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode=',
        { timeoutMs: 10000 }
      );
      if (clazz && Number(clazz.result) === 1) {
        return { ok: true, actualUid: claimed };
      }
      return {
        ok: false,
        expired: true,
        reason: '学习通会话校验未通过，请重新登录',
      };
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return { ok: false, expired: true, reason: err.message };
      }
      return {
        ok: false,
        expired: false,
        reason: `学习通归属校验失败: ${String(err)}`,
      };
    }
  }

  async getCoursesList(): Promise<OnlineCourse[]> {
    const data = await this.requestJson(
      'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode='
    );
    if (!data || data.result !== 1 || !Array.isArray(data.channelList)) {
      return [];
    }

    const out: OnlineCourse[] = [];
    for (const rawChannel of data.channelList) {
      const ch = asRecord(rawChannel);
      const content = asRecord(ch?.content);
      const courseWrapper = asRecord(content?.course);
      const courseArr = courseWrapper?.data;
      if (!Array.isArray(courseArr) || courseArr.length === 0) continue;
      const c = asRecord(courseArr[0]);
      if (!c) continue;
      const state = content?.state;
      if (state === 1) continue; // 已结课

      out.push({
        courseId: String(c.id ?? ''),
        classId: String(content?.id ?? ''),
        name: String(c.name ?? ''),
        teacher: String(c.teacherfactor ?? ''),
        cpi: String(ch?.cpi ?? ''),
      });
    }
    return out.filter((c) => c.courseId && c.name);
  }

  private async getJoinClassTime(
    courseId: string,
    classId: string,
    cpi: string
  ): Promise<string> {
    const data = await this.requestJson(
      'https://mooc1-api.chaoxing.com/gas/clazzperson',
      {
        params: {
          courseid: courseId,
          clazzid: classId,
          userid: this.account.uid,
          personid: cpi,
          view: 'json',
          fields: 'clazzid,popupagreement,personid,clazzname,createtime',
        },
      }
    );
    const list = data?.data;
    if (Array.isArray(list) && list.length > 0) {
      const first = asRecord(list[0]);
      if (first?.createtime) return String(first.createtime);
    }
    return '';
  }

  async getOngoingSignActives(
    courseId: string,
    classId: string,
    cpi: string
  ): Promise<CxActiveItem[]> {
    const joinClassTime = await this.getJoinClassTime(courseId, classId, cpi);

    const taskParams: Record<string, string> = {
      courseId,
      classId,
      uid: this.account.uid,
      cpi,
      joinclasstime: joinClassTime,
    };
    Object.assign(taskParams, getCxEncParams(taskParams));

    const [taskData, webData] = await Promise.all([
      this.requestJson(
        'https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist',
        { params: taskParams }
      ),
      this.requestJson(
        'https://mobilelearn.chaoxing.com/v2/apis/active/student/activelist',
        {
          params: {
            fid: '0',
            courseId,
            classId,
            showNotStartedActive: '0',
            _: Date.now().toString(),
          },
        }
      ),
    ]);

    const webMap = new Map<string, Record<string, unknown>>();
    const webInner = asRecord(webData?.data);
    if (Array.isArray(webInner?.activeList)) {
      for (const item of webInner.activeList) {
        const m = asRecord(item);
        if (m?.id !== undefined) {
          webMap.set(String(m.id), m);
        }
      }
    }

    const result: CxActiveItem[] = [];
    const seen = new Set<string>();
    const rawList = Array.isArray(taskData?.activeList)
      ? taskData.activeList
      : Array.isArray(webInner?.activeList)
        ? webInner.activeList
        : [];

    for (const raw of rawList) {
      const m = asRecord(raw);
      if (!m || m.id === undefined) continue;
      const id = String(m.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const webItem = webMap.get(id);
      const status = asNumber(m.status ?? webItem?.status) ?? 0;
      const activeType = asNumber(m.activeType ?? webItem?.activeType) ?? 0;
      // 2 = 普通签到, 74 = 定时签到
      if (status !== 1 || (activeType !== 2 && activeType !== 74)) continue;

      const otherId = asNumber(webItem?.otherId ?? m.otherId) ?? 0;
      result.push({
        id,
        name: String(m.nameOne ?? webItem?.nameOne ?? '签到活动'),
        activeType,
        status,
        otherId,
        url: String(
          m.url ??
            webItem?.url ??
            `https://mobilelearn.chaoxing.com/widget/sign/e?activeId=${id}`
        ),
      });
    }
    return result;
  }

  async getActiveDetail(activeId: string): Promise<CxActiveDetail | null> {
    const [webInfoResp, signDetail] = await Promise.all([
      this.requestJson(
        'https://mobilelearn.chaoxing.com/v2/apis/active/getPPTActiveInfo',
        { params: { activeId } }
      ),
      this.requestJson('https://mobilelearn.chaoxing.com/newsign/signDetail', {
        params: { activePrimaryId: activeId, type: '1' },
      }),
    ]);

    const webData =
      webInfoResp?.result === 1 ? asRecord(webInfoResp.data) : null;
    const merged: Record<string, unknown> = {
      ...(signDetail ?? {}),
      ...(webData ?? {}),
    };
    if (Object.keys(merged).length === 0) return null;

    const otherId = asNumber(merged.otherId) ?? 0;
    const needPhoto = asNumber(merged.ifphoto) === 1;
    const needFace = asNumber(merged.openCheckFaceFlag) === 1;
    const needCaptcha = asNumber(merged.showVCode) === 1;

    const locationLat = asNumber(
      merged.locationLatitude ?? merged.latitude ?? merged.lat
    );
    const locationLng = asNumber(
      merged.locationLongitude ?? merged.longitude ?? merged.lng
    );
    const locationText =
      typeof merged.locationText === 'string' && merged.locationText.trim()
        ? merged.locationText.trim()
        : null;
    const locationRange = asNumber(merged.locationRange);

    return {
      otherId,
      needPhoto,
      needFace,
      needCaptcha,
      locationLat,
      locationLng,
      locationText,
      locationRange,
      raw: merged,
    };
  }

  async isAlreadySigned(activeId: string): Promise<boolean> {
    const data = await this.requestJson(
      'https://mobilelearn.chaoxing.com/v2/apis/sign/getAttendInfo',
      {
        params: { activeId, moreClassAttendEnc: '' },
      }
    );
    if (!data || data.result !== 1) return false;
    const inner = asRecord(data.data);
    const status = asNumber(inner?.status);
    return status === 1 || status === 2;
  }

  async normalSign(
    courseId: string,
    activeId: string,
    refererUrl: string
  ): Promise<string> {
    const params: Record<string, string> = {
      activeId,
      courseId,
      uid: this.account.uid,
      clientip: '',
      latitude: '-1',
      longitude: '-1',
      appType: '15',
      fid: '0',
      name: this.account.name,
      deviceCode: getCxDeviceCode(),
    };
    const { text } = await this.request(
      'https://mobilelearn.chaoxing.com/pptSign/stuSignajax',
      {
        method: 'GET',
        params,
        headers: { Referer: refererUrl },
      }
    );
    return text.trim();
  }

  async locationSign(
    courseId: string,
    activeId: string,
    address: string,
    latitude: number,
    longitude: number,
    refererUrl: string
  ): Promise<string> {
    const formBody: Record<string, string> = {
      name: this.account.name,
      address,
      activeId,
      courseId,
      uid: this.account.uid,
      clientip: '',
      latitude: latitude.toFixed(6),
      longitude: longitude.toFixed(6),
      fid: '0',
      appType: '15',
      ifTiJiao: '1',
      validate: '',
      deviceCode: getCxDeviceCode(),
      vpProbability: '-1',
      vpStrategy: '',
      currentFaceId: '',
      ifCFP: '0',
      faceEnc: '',
      locationResult: buildCxLocationResultJson(
        this.account.deviceInfo,
        address,
        latitude,
        longitude
      ),
    };
    const { text } = await this.request(
      'https://mobilelearn.chaoxing.com/pptSign/stuSignajax',
      {
        method: 'POST',
        formBody,
        headers: { Referer: refererUrl },
      }
    );
    return text.trim();
  }
}

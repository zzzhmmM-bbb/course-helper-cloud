import { getUniqueId } from '../crypto.js';
import {
  rcServerBaseUrl,
  type OnlineCourse,
  type OwnershipVerifyResult,
  type PresentationData,
  type PresentationSlide,
  type ProblemData,
  type StoredAccount,
} from '../types.js';

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export interface RcOnLessonItem {
  lessonId: string;
  courseId: string;
  classroomId: string;
  courseName: string;
}

export interface RcCheckInResult {
  code: number;
  bearerToken: string | null;
  lessonToken: string | null;
  msg?: string;
}

export interface RcLocationEligibility {
  code: number | null;
  msg: string | null;
  needLocationSignIn: boolean;
  signed: boolean;
  canSign: boolean | null;
  centerLat: number | null;
  centerLng: number | null;
  radius: number | null;
  address: string | null;
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

function firstNonEmptyString(values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function parseLocationEligibility(
  raw: Record<string, unknown>,
  wsData?: Record<string, unknown>
): RcLocationEligibility {
  const innerData = asRecord(raw.data);
  const payload = innerData ?? raw;
  const sessionMap =
    asRecord(payload.session) ?? asRecord(wsData?.session) ?? null;

  const code = asNumber(raw.code);
  const msg = firstNonEmptyString([raw.msg, raw.message, payload.msg]);
  const mode = firstNonEmptyString([payload.mode, raw.mode]);
  const signed = payload.signed === true || mode === 'signed';

  let explicitNeed: boolean | null = null;
  if (typeof payload.needLocationSignIn === 'boolean') {
    explicitNeed = payload.needLocationSignIn;
  } else if (typeof payload.need_location_sign_in === 'boolean') {
    explicitNeed = payload.need_location_sign_in;
  }

  const needLocationSignIn =
    explicitNeed ??
    (wsData !== undefined ||
      mode === 'unsigned' ||
      mode === 'pending' ||
      (sessionMap !== null && !signed));

  const centerLat =
    asNumber(sessionMap?.centerLat) ??
    asNumber(sessionMap?.lat) ??
    asNumber(payload.centerLat) ??
    asNumber(payload.lat) ??
    asNumber(wsData?.centerLat) ??
    asNumber(wsData?.lat);

  const centerLng =
    asNumber(sessionMap?.centerLng) ??
    asNumber(sessionMap?.lng) ??
    asNumber(sessionMap?.lon) ??
    asNumber(payload.centerLng) ??
    asNumber(payload.lng) ??
    asNumber(payload.lon) ??
    asNumber(wsData?.centerLng) ??
    asNumber(wsData?.lng);

  const radius =
    asNumber(sessionMap?.radiusM) ??
    asNumber(sessionMap?.radius) ??
    asNumber(sessionMap?.range) ??
    asNumber(sessionMap?.distance) ??
    asNumber(payload.radiusM) ??
    asNumber(payload.radius) ??
    asNumber(payload.range) ??
    asNumber(wsData?.radiusM) ??
    asNumber(wsData?.radius);

  const address = firstNonEmptyString([
    sessionMap?.locationName,
    sessionMap?.address,
    sessionMap?.location,
    sessionMap?.place,
    sessionMap?.title,
    payload.locationName,
    payload.address,
    wsData?.locationName,
    wsData?.address,
  ]);

  const canSign = typeof payload.canSign === 'boolean' ? payload.canSign : null;

  return {
    code,
    msg,
    needLocationSignIn,
    signed,
    canSign,
    centerLat,
    centerLng,
    radius,
    address,
    raw,
  };
}

export function requiresPendingLocationSignIn(
  eligibility: RcLocationEligibility | null
): boolean {
  return Boolean(
    eligibility &&
      eligibility.needLocationSignIn &&
      !eligibility.signed &&
      eligibility.canSign !== false
  );
}

export class RainClassroomClient {
  private readonly uniqueId = getUniqueId();
  private readonly cookies: Record<string, string>;

  constructor(
    private readonly account: StoredAccount,
    private readonly onCookiesUpdated?: (cookies: Record<string, string>) => void
  ) {
    this.cookies = { ...account.cookies };
  }

  private get baseUrl(): string {
    return rcServerBaseUrl(this.account.server);
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cookieStr = Object.entries(this.cookies)
      .filter(([, v]) => v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const headers: Record<string, string> = {
      'user-agent': 'Android',
      brand: 'google Pixel 9 Pro',
      uuid: this.uniqueId,
      buildnumber: '1610',
      xtua: 'client=app&tag=1.3.3&platform=Android',
      systemversion: '16',
      incremental: '14624737',
      accept: 'application/json',
      isphysicaldevice: 'true',
      xtbz: 'ykt',
      'x-client': 'app',
      // 协议红线：x-uid 始终传原始数字 user.uid
      'x-uid': String(this.account.uid),
    };

    if (cookieStr) {
      headers.Cookie = cookieStr;
    }
    if (this.cookies.csrftoken) {
      headers['x-csrftoken'] = this.cookies.csrftoken;
    }
    if (this.cookies.sessionid) {
      headers.sessionid = this.cookies.sessionid;
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

  private async requestJson(
    pathOrUrl: string,
    options: {
      method?: 'GET' | 'POST';
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    } = {}
  ): Promise<{ status: number; headers: Headers; data: Record<string, unknown> }> {
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const method = options.method ?? 'GET';
    const headers = this.buildHeaders(options.headers);
    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 15000
    );
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      this.mergeSetCookies(resp);

      if (resp.status === 401 || resp.status === 403) {
        throw new SessionExpiredError(
          `雨课堂登录态已过期 (HTTP ${resp.status})`
        );
      }

      const text = await resp.text();
      let parsed: Record<string, unknown> = {};
      if (text.trim()) {
        try {
          const json = JSON.parse(text);
          parsed = asRecord(json) ?? { raw: json };
        } catch {
          if (text.includes('login') || text.includes('<!DOCTYPE html>')) {
            throw new SessionExpiredError('雨课堂返回登录页，Cookie 已失效');
          }
          parsed = { rawText: text };
        }
      }

      const code = asNumber(parsed.code);
      const msg = String(parsed.msg ?? parsed.message ?? '');
      if (
        code === 401 ||
        code === 403 ||
        code === 50001 ||
        msg.includes('未登录') ||
        msg.includes('登录已过期')
      ) {
        throw new SessionExpiredError(
          `雨课堂会话失效: ${msg || `code=${code}`}`
        );
      }

      return { status: resp.status, headers: resp.headers, data: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 严格校验证明当前 Cookie 确实归属于 expectedUid（调用 /v/course_meta/user_info 比对真实 user_id）。
   */
  async verifyOwnership(expectedUid: string): Promise<OwnershipVerifyResult> {
    const claimed = String(expectedUid ?? '').trim();
    if (!claimed) {
      return { ok: false, expired: false, reason: '缺少目标 UID' };
    }
    if (!this.cookies.sessionid) {
      return { ok: false, expired: true, reason: '雨课堂 Cookie 缺少 sessionid' };
    }
    try {
      const { data } = await this.requestJson('/v/course_meta/user_info', {
        timeoutMs: 10000,
      });
      const inner = asRecord(data.data);
      const profile =
        asRecord(inner?.user_profile) ?? asRecord(data.user_profile);
      const rawUid =
        profile?.user_id ?? inner?.user_id ?? data.user_id ?? null;
      const actualUid = rawUid !== null && rawUid !== undefined ? String(rawUid).trim() : '';
      if (!actualUid) {
        return {
          ok: false,
          expired: true,
          reason: '无法从雨课堂用户信息接口确认 UID',
        };
      }
      if (actualUid !== claimed) {
        return {
          ok: false,
          expired: false,
          actualUid,
          reason: '雨课堂 Cookie 所属账号与目标 UID 不一致',
        };
      }
      return { ok: true, actualUid };
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return { ok: false, expired: true, reason: err.message };
      }
      return {
        ok: false,
        expired: false,
        reason: `雨课堂归属校验失败: ${String(err)}`,
      };
    }
  }

  async getAllEnrolledCourses(): Promise<OnlineCourse[]> {
    const { data } = await this.requestJson('/v/course_meta/learning_list/');
    const rawList = data.data;
    if (!Array.isArray(rawList)) return [];

    const result: OnlineCourse[] = [];
    const seen = new Set<string>();
    for (const item of rawList) {
      const map = asRecord(item);
      if (!map) continue;
      const courseId = String(map.course_id ?? '').trim();
      const classId = String(map.classroom_id ?? map.class_id ?? '').trim();
      const name = String(map.course_name ?? map.name ?? '').trim();
      const teacher = String(map.teacher_name ?? map.teacher ?? '').trim();
      if (!courseId || !name) continue;
      const dedup = `${courseId}_${classId}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      result.push({ courseId, classId, name, teacher });
    }
    return result;
  }

  /**
   * 实时无缓存拉取正在上课的雨课堂课程。
   */
  async getOnLesson(): Promise<RcOnLessonItem[]> {
    const { data } = await this.requestJson('/api/v3/classroom/on-lesson');
    if (asNumber(data.code) !== 0) return [];
    const inner = asRecord(data.data);
    const list = inner?.onLessonClassrooms;
    if (!Array.isArray(list)) return [];

    const out: RcOnLessonItem[] = [];
    for (const item of list) {
      const m = asRecord(item);
      if (!m) continue;
      const lessonId = String(m.lessonId ?? '').trim();
      if (!lessonId) continue;
      out.push({
        lessonId,
        courseId: String(m.courseId ?? '').trim(),
        classroomId: String(m.classroomId ?? '').trim(),
        courseName: String(m.courseName ?? '').trim(),
      });
    }
    return out;
  }

  /**
   * 免扫码进班签到（协议红线：source = 21）。
   */
  async checkIn(lessonId: string): Promise<RcCheckInResult> {
    const { headers, data } = await this.requestJson('/api/v3/lesson/checkin', {
      method: 'POST',
      body: {
        source: 21,
        lessonId,
        joinIfNotIn: true,
      },
    });
    const code = asNumber(data.code) ?? -1;
    const inner = asRecord(data.data);
    const bearerToken = headers.get('set-auth');
    const lessonToken = inner?.lessonToken ? String(inner.lessonToken) : null;
    return {
      code,
      bearerToken,
      lessonToken,
      msg: firstNonEmptyString([data.msg, data.message]) ?? undefined,
    };
  }

  async getLocationCheckInEligibility(
    bearerToken: string,
    wsData?: Record<string, unknown>
  ): Promise<RcLocationEligibility | null> {
    const { data } = await this.requestJson(
      '/api/v3/lesson/location-checkin/eligibility',
      {
        headers: { authorization: `Bearer ${bearerToken}` },
      }
    );
    return parseLocationEligibility(data, wsData);
  }

  /**
   * 提交定位签到（协议红线：source = 27，lat/lng 必须为字符串）。
   */
  async submitLocationCheckIn(
    bearerToken: string,
    lessonId: string,
    latitude: number,
    longitude: number,
    address: string
  ): Promise<Record<string, unknown>> {
    const { data } = await this.requestJson(
      '/api/v3/lesson/location-checkin/submit',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${bearerToken}` },
        body: {
          lat: String(latitude),
          lng: String(longitude),
          lessonId,
          source: 27,
          address,
        },
      }
    );
    return data;
  }

  async getPresentation(
    bearerToken: string,
    presentationId: string
  ): Promise<PresentationData | null> {
    const { data } = await this.requestJson(
      `/api/v3/lesson/presentation/fetch?presentation_id=${encodeURIComponent(presentationId)}`,
      {
        headers: { authorization: `Bearer ${bearerToken}` },
      }
    );
    const inner = asRecord(data.data);
    if (!inner) return null;

    const rawSlides = Array.isArray(inner.slides) ? inner.slides : [];
    const slides: PresentationSlide[] = rawSlides
      .map((s) => asRecord(s))
      .filter((s): s is Record<string, unknown> => s !== null)
      .map((s) => {
        const rawShapes = Array.isArray(s.shapes) ? s.shapes : [];
        const shapes = rawShapes
          .map((sh) => asRecord(sh))
          .filter((sh): sh is Record<string, unknown> => sh !== null)
          .map((sh) => ({
            text:
              typeof sh.Text === 'string'
                ? sh.Text
                : typeof sh.text === 'string'
                  ? sh.text
                  : undefined,
          }));

        let problem: ProblemData | undefined;
        const p = asRecord(s.problem);
        if (p) {
          const rawOpts = Array.isArray(p.options) ? p.options : [];
          const options = rawOpts
            .map((o) => asRecord(o))
            .filter((o): o is Record<string, unknown> => o !== null)
            .map((o) => ({
              key: String(o.key ?? ''),
              value: String(o.value ?? ''),
            }));

          const rawBlanks = Array.isArray(p.blanks) ? p.blanks : [];
          const blanks = rawBlanks
            .map((b) => asRecord(b))
            .filter((b): b is Record<string, unknown> => b !== null)
            .map((b) => ({
              num: asNumber(b.num) ?? 0,
              score: asNumber(b.score) ?? 0,
              answers: Array.isArray(b.answers)
                ? b.answers.map((a) => String(a))
                : [],
            }));

          problem = {
            problemId: String(p.problemId ?? ''),
            problemType: asNumber(p.problemType) ?? 0,
            body: String(p.body ?? ''),
            score: asNumber(p.score) ?? 0,
            remark: String(p.remark ?? ''),
            options,
            pollingCount: asNumber(p.pollingCount) ?? undefined,
            dt: asNumber(p.dt) ?? undefined,
            blanks,
          };
        }

        return {
          id: String(s.id ?? ''),
          index: asNumber(s.index) ?? 0,
          cover: String(s.cover ?? ''),
          coverAlt: String(s.coverAlt ?? ''),
          thumbnail: String(s.thumbnail ?? ''),
          shapes,
          note: String(s.note ?? ''),
          problem,
        };
      });

    return {
      title: String(inner.title ?? ''),
      width: asNumber(inner.width) ?? 720,
      height: asNumber(inner.height) ?? 540,
      version: String(inner.version ?? '1.0'),
      slides,
    };
  }

  async submitAnswer(
    bearerToken: string,
    params: {
      problemId: string;
      problemType: number;
      retry?: boolean;
      time?: number;
      options?: string[];
      content?: string;
    }
  ): Promise<Record<string, unknown>> {
    const url = params.retry
      ? '/api/v3/lesson/problem/retry'
      : '/api/v3/lesson/problem/answer';
    const dt = params.time ?? Date.now();
    const result =
      params.problemType === 5
        ? {
            content: params.content ?? '',
            pics: [{ pic: '', thumb: '' }],
            videos: [],
          }
        : params.options ?? [];

    const payload: Record<string, unknown> = {
      problemId: params.problemId,
      dt,
      problemType: params.problemType,
      result,
    };

    const body = params.retry
      ? { problems: [{ ...payload, retry_times: null }] }
      : payload;

    const { data } = await this.requestJson(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}` },
      body,
    });
    return data;
  }
}

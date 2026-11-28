import WebSocket from 'ws';
import {
  isAiReady,
  solveProblemWithVisionAi,
  type AiSolveResult,
} from '../ai/vision_solver.js';
import { resolveLocationForSignIn } from '../campus.js';
import type { Logger } from '../config.js';
import type { CloudDatabase } from '../db.js';
import {
  RainClassroomClient,
  requiresPendingLocationSignIn,
  SessionExpiredError,
} from '../protocols/rainclassroom.js';
import { formatUtc8Iso } from '../time.js';
import {
  rcServerWsUrl,
  type ActiveSessionSnapshot,
  type PresentationData,
  type PresentationSlide,
  type ProblemData,
  type RcLessonGuardLocation,
  type StoredAccount,
} from '../types.js';

interface InternalLessonSession {
  sessionKey: string;
  accountKey: string;
  accountName: string;
  lessonId: string;
  courseId: string;
  courseTitle: string;
  classroom: string;
  bearerToken: string | null;
  lessonToken: string | null;
  watchOnly: boolean;
  guardLocationFallback: RcLessonGuardLocation | null;
  ws: WebSocket | null;
  isConnected: boolean;
  paused: boolean;
  isFinished: boolean;
  disposed: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  healthTimer: NodeJS.Timeout | null;
  delayTimers: Map<string, () => void>;
  inFlightProblemIds: Set<string>;
  problemUnlockedAt: Map<string, number>;
  problemLimits: Map<string, number>;
  presentations: Map<string, PresentationData>;
  currentPresentationId: string | null;
  currentSlideIndex: number;
  solvedCount: number;
  startedAt: string;
  lastActivityAt: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class RcAutoAnswerEngine {
  private readonly sessions = new Map<string, InternalLessonSession>();
  private readonly finishedKeys = new Set<string>();
  private onLessonFinishedCallback:
    | ((accountKey: string, lessonId: string, courseId: string) => void)
    | null = null;

  constructor(
    private readonly db: CloudDatabase,
    private readonly logger: Logger
  ) {}

  setOnLessonFinished(
    cb: ((accountKey: string, lessonId: string, courseId: string) => void) | null
  ): void {
    this.onLessonFinishedCallback = cb;
  }

  static buildSessionKey(accountKey: string, lessonId: string): string {
    return `${accountKey}::${lessonId}`;
  }

  isWatching(accountKey: string, lessonId: string): boolean {
    const key = RcAutoAnswerEngine.buildSessionKey(accountKey, lessonId);
    const s = this.sessions.get(key);
    return Boolean(s && !s.disposed && !s.isFinished);
  }

  isLessonFinished(accountKey: string, lessonId: string): boolean {
    return this.finishedKeys.has(
      RcAutoAnswerEngine.buildSessionKey(accountKey, lessonId)
    );
  }

  getActiveCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (!s.disposed && !s.isFinished && !s.watchOnly) count++;
    }
    return count;
  }

  getSessionsForAccounts(accountKeys: Iterable<string>): ActiveSessionSnapshot[] {
    const keySet = new Set(accountKeys);
    const out: ActiveSessionSnapshot[] = [];
    for (const s of this.sessions.values()) {
      if (!keySet.has(s.accountKey) || s.disposed || s.isFinished || s.watchOnly) {
        continue;
      }
      out.push({
        sessionKey: s.sessionKey,
        accountKey: s.accountKey,
        accountName: s.accountName,
        lessonId: s.lessonId,
        courseId: s.courseId,
        courseTitle: s.courseTitle,
        isConnected: s.isConnected,
        paused: s.paused,
        isFinished: s.isFinished,
        currentSlideIndex: s.currentSlideIndex,
        solvedCount: s.solvedCount,
        pendingCount: s.inFlightProblemIds.size,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
      });
    }
    return out;
  }

  getSessionAccountKey(sessionKey: string): string | null {
    const s = this.sessions.get(sessionKey);
    if (!s || s.disposed || s.isFinished) return null;
    return s.accountKey;
  }

  setSessionPaused(
    sessionKey: string,
    paused: boolean,
    allowedAccountKeys?: Iterable<string>
  ): boolean {
    const s = this.sessions.get(sessionKey);
    if (!s || s.disposed || s.isFinished) {
      return false;
    }
    if (allowedAccountKeys) {
      const allowed = new Set(allowedAccountKeys);
      if (!allowed.has(s.accountKey)) return false;
    }
    s.paused = paused;
    s.lastActivityAt = formatUtc8Iso();
    if (paused) {
      for (const cancel of s.delayTimers.values()) {
        cancel();
      }
      s.delayTimers.clear();
    }
    this.db.addLog({
      accountKey: s.accountKey,
      accountName: s.accountName,
      platform: 'rainClassroom',
      category: 'session',
      level: 'info',
      title: paused ? '已暂停云端自动答题' : '已恢复云端自动答题',
      detail: `课程《${s.courseTitle}》(${s.lessonId})`,
      courseName: s.courseTitle,
      lessonId: s.lessonId,
    });
    return true;
  }

  /**
   * 账号退出/被移除时立即断开其全部雨课堂 WS 会话并清理定时器。
   */
  detachAccount(accountKey: string): number {
    let detached = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (session.accountKey === accountKey) {
        this.disposeSession(session);
        this.sessions.delete(key);
        detached++;
      }
    }
    return detached;
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
    }
    this.sessions.clear();
  }

  async attachLesson(params: {
    account: StoredAccount;
    lessonId: string;
    courseId?: string;
    courseTitle?: string;
    classroom?: string;
    bearerToken?: string | null;
    lessonToken?: string | null;
    watchOnly?: boolean;
    guardLocationFallback?: RcLessonGuardLocation | null;
  }): Promise<void> {
    const { account, lessonId } = params;
    const aiReady = isAiReady(account.aiConfig);
    const watchOnly = params.watchOnly ?? !aiReady;
    if (!aiReady && !watchOnly) return;
    if (!lessonId) return;

    const sessionKey = RcAutoAnswerEngine.buildSessionKey(
      account.accountKey,
      lessonId
    );
    this.finishedKeys.delete(sessionKey);

    const existing = this.sessions.get(sessionKey);
    if (existing && !existing.disposed && !existing.isFinished) {
      if (params.bearerToken) existing.bearerToken = params.bearerToken;
      if (params.lessonToken) existing.lessonToken = params.lessonToken;
      if (params.courseTitle?.trim()) {
        existing.courseTitle = params.courseTitle.trim();
      }
      if (params.guardLocationFallback) {
        existing.guardLocationFallback = params.guardLocationFallback;
      }
      if (existing.watchOnly && aiReady && !watchOnly) {
        existing.watchOnly = false;
      }
      return;
    }

    const nowIso = formatUtc8Iso();
    const session: InternalLessonSession = {
      sessionKey,
      accountKey: account.accountKey,
      accountName: account.name,
      lessonId,
      courseId: params.courseId ?? '',
      courseTitle: params.courseTitle?.trim() || '雨课堂课堂',
      classroom: params.classroom ?? '',
      bearerToken: params.bearerToken ?? null,
      lessonToken: params.lessonToken ?? null,
      watchOnly,
      guardLocationFallback: params.guardLocationFallback ?? null,
      ws: null,
      isConnected: false,
      paused: false,
      isFinished: false,
      disposed: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      healthTimer: null,
      delayTimers: new Map(),
      inFlightProblemIds: new Set(),
      problemUnlockedAt: new Map(),
      problemLimits: new Map(),
      presentations: new Map(),
      currentPresentationId: null,
      currentSlideIndex: 0,
      solvedCount: 0,
      startedAt: nowIso,
      lastActivityAt: nowIso,
    };

    this.sessions.set(sessionKey, session);
    if (!watchOnly) {
      this.db.addLog({
        accountKey: account.accountKey,
        accountName: account.name,
        platform: 'rainClassroom',
        category: 'session',
        level: 'info',
        title: `已开启云端 AI 课堂托管《${session.courseTitle}》`,
        detail: `账号 ${account.name} 已挂载课堂 WebSocket 监听 (${lessonId})`,
        courseName: session.courseTitle,
        lessonId,
      });
    }

    await this.connectSession(session);
  }

  private getFreshAccount(session: InternalLessonSession): StoredAccount | null {
    return this.db.getAccount(session.accountKey);
  }

  private async connectSession(session: InternalLessonSession): Promise<void> {
    if (session.disposed || session.isFinished) return;
    const account = this.getFreshAccount(session);
    if (!account || !isAiReady(account.aiConfig)) {
      this.disposeSession(session);
      this.sessions.delete(session.sessionKey);
      return;
    }

    try {
      const client = new RainClassroomClient(account, (updatedCookies) => {
        this.db.updateAccountCookies(account.accountKey, updatedCookies);
      });

      if (!session.bearerToken || !session.lessonToken) {
        const res = await client.checkIn(session.lessonId);
        if (res.code !== 0 || !res.bearerToken || !res.lessonToken) {
          this.logger.warn(
            'rc-ws',
            `刷新 lessonToken 失败 code=${res.code} lesson=${session.lessonId}`
          );
          this.scheduleReconnect(session);
          return;
        }
        session.bearerToken = res.bearerToken;
        session.lessonToken = res.lessonToken;
      }

      if (session.disposed || session.isFinished) return;

      if (session.ws) {
        try {
          session.ws.removeAllListeners();
          session.ws.close();
        } catch {
          // ignore
        }
        session.ws = null;
      }

      const wsUrl = rcServerWsUrl(account.server);
      const ws = new WebSocket(wsUrl);
      session.ws = ws;

      ws.on('open', () => {
        if (session.disposed || session.isFinished) {
          ws.close();
          return;
        }
        session.isConnected = true;
        session.reconnectAttempts = 0;
        session.lastActivityAt = formatUtc8Iso();

        // 协议红线：WS hello 的 userid 始终传原始数字 user.uid
        ws.send(
          JSON.stringify({
            op: 'hello',
            userid: String(account.uid),
            role: 'student',
            auth: session.lessonToken,
            lessonid: session.lessonId,
          })
        );
      });

      ws.on('message', (raw) => {
        void this.onMessage(session, raw.toString('utf8'));
      });

      ws.on('error', (err) => {
        this.logger.warn(
          'rc-ws',
          `WS 异常 (${session.courseTitle}): ${err.message}`
        );
        session.isConnected = false;
      });

      ws.on('close', () => {
        session.isConnected = false;
        if (!session.disposed && !session.isFinished) {
          session.lessonToken = null;
          this.scheduleReconnect(session);
        }
      });

      if (session.healthTimer) clearInterval(session.healthTimer);
      session.healthTimer = setInterval(() => {
        if (session.disposed || session.isFinished) return;
        if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
          session.isConnected = false;
          this.scheduleReconnect(session);
        }
      }, 25000);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        this.db.setAccountSessionStatus(
          account.accountKey,
          'session_expired',
          err.message
        );
        this.db.addLog({
          accountKey: account.accountKey,
          accountName: account.name,
          platform: 'rainClassroom',
          category: 'session',
          level: 'error',
          title: '账号登录态已失效，云端托管停止',
          detail: `${err.message}，请在 App 重新登录后自动恢复`,
          courseName: session.courseTitle,
          lessonId: session.lessonId,
        });
        this.disposeSession(session);
        this.sessions.delete(session.sessionKey);
        return;
      }
      this.logger.warn(
        'rc-ws',
        `连接 WS 失败 (${session.courseTitle}): ${String(err)}`
      );
      this.scheduleReconnect(session);
    }
  }

  private scheduleReconnect(session: InternalLessonSession): void {
    if (session.disposed || session.isFinished) return;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectAttempts++;
    const delayMs = Math.min(20000, 3000 * session.reconnectAttempts);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (!session.disposed && !session.isFinished) {
        void this.connectSession(session);
      }
    }, delayMs);
  }

  private async onMessage(
    session: InternalLessonSession,
    rawText: string
  ): Promise<void> {
    if (session.disposed || session.isFinished) return;
    let data: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(rawText));
      if (!parsed) return;
      data = parsed;
    } catch {
      return;
    }

    session.lastActivityAt = formatUtc8Iso();
    const op = typeof data.op === 'string' ? data.op : '';
    const msgText = typeof data.message === 'string' ? data.message : '';

    switch (op) {
      case 'hello':
        if (msgText === 'lesson finished') {
          this.finishSession(session);
          return;
        }
        await this.handleHello(session, data);
        break;

      case 'showpresentation': {
        const presId =
          typeof data.presentation === 'string' ? data.presentation : null;
        const slideIdx = asInt(data.slideindex);
        if (slideIdx !== null) session.currentSlideIndex = slideIdx;
        if (presId) {
          session.currentPresentationId = presId;
          await this.ensurePresentationLoaded(session, presId);
        }
        break;
      }

      case 'slide':
      case 'slidenav': {
        const slideObj = asRecord(data.slide);
        const idx =
          op === 'slide' ? asInt(data.slideindex) : asInt(slideObj?.si);
        if (idx !== null) session.currentSlideIndex = idx;
        break;
      }

      case 'unlockproblem': {
        const probMap = asRecord(data.problem);
        if (!probMap) break;
        const problemId = String(probMap.prob ?? probMap.sid ?? '').trim();
        const presId =
          (typeof probMap.pres === 'string' && probMap.pres) ||
          session.currentPresentationId;
        const limit = asInt(probMap.limit);
        const dt = asInt(probMap.dt);
        if (problemId) {
          session.problemUnlockedAt.set(problemId, Date.now());
          if (limit !== null) session.problemLimits.set(problemId, limit);
          void this.processProblem({
            session,
            problemId,
            presentationId: presId,
            limitSec: limit,
            problemDt: dt,
            isExpired: false,
          });
        }
        break;
      }

      case 'extendtime': {
        const probMap = asRecord(data.problem);
        if (!probMap) break;
        const probId = String(probMap.prob ?? probMap.sid ?? '').trim();
        const extend = asInt(probMap.extend) ?? 0;
        if (probId && extend > 0) {
          const prev = session.problemLimits.get(probId);
          if (prev && prev > 0) {
            session.problemLimits.set(probId, prev + extend);
          }
        }
        break;
      }

      case 'locationcheckin': {
        await this.handleMidClassLocationCheckIn(session, data);
        break;
      }

      case 'lessonfinished':
        this.finishSession(session);
        break;
    }
  }

  private async handleMidClassLocationCheckIn(
    session: InternalLessonSession,
    wsData: Record<string, unknown>
  ): Promise<void> {
    const account = this.getFreshAccount(session);
    if (!account || !session.bearerToken) return;
    try {
      const client = new RainClassroomClient(account, (cookies) => {
        this.db.updateAccountCookies(account.accountKey, cookies);
      });
      const eligibility = await client.getLocationCheckInEligibility(
        session.bearerToken,
        wsData
      );
      if (!requiresPendingLocationSignIn(eligibility)) return;

      const preset =
        (session.courseId
          ? account.courseLocations[session.courseId] ?? null
          : null) ??
        (session.guardLocationFallback
          ? {
              address: session.guardLocationFallback.address,
              latitude: session.guardLocationFallback.latitude,
              longitude: session.guardLocationFallback.longitude,
              coordType: 'gcj02' as const,
            }
          : null);
      const loc = resolveLocationForSignIn({
        targetCoord: 'gcj02',
        preset,
        teacherLat: eligibility?.centerLat,
        teacherLng: eligibility?.centerLng,
        teacherAddress: eligibility?.address,
        classroom: session.classroom,
      });

      const res = await client.submitLocationCheckIn(
        session.bearerToken,
        session.lessonId,
        loc.latitude,
        loc.longitude,
        loc.address
      );
      if (asInt(res.code) === 0) {
        this.db.addLog({
          accountKey: account.accountKey,
          accountName: account.name,
          platform: 'rainClassroom',
          category: 'location',
          level: 'success',
          title: `课中定位签到成功《${session.courseTitle}》`,
          detail: `已自动提交定位 (${loc.address}, 来源: ${loc.source})`,
          courseName: session.courseTitle,
          lessonId: session.lessonId,
        });
      }
    } catch (err) {
      this.logger.warn(
        'rc-ws',
        `课中定位签到失败 (${session.courseTitle}): ${String(err)}`
      );
    }
  }

  private async handleHello(
    session: InternalLessonSession,
    data: Record<string, unknown>
  ): Promise<void> {
    const presId =
      typeof data.presentation === 'string' ? data.presentation : null;
    const slideIdx = asInt(data.slideindex);
    const timeline = Array.isArray(data.timeline) ? data.timeline : [];

    let latestPresId: string | null = null;
    let latestSlideIdx: number | null = null;
    const historicalProblems: Record<string, unknown>[] = [];

    for (const rawEv of timeline) {
      const ev = asRecord(rawEv);
      if (!ev) continue;
      if (ev.type === 'slide' && typeof ev.pres === 'string') {
        latestPresId = ev.pres;
        latestSlideIdx = asInt(ev.si);
      } else if (ev.type === 'problem' && ev.prob !== undefined) {
        historicalProblems.push(ev);
      }
    }

    const targetPres = latestPresId ?? presId;
    const targetSlide = latestSlideIdx ?? slideIdx;
    if (targetSlide !== null) session.currentSlideIndex = targetSlide;
    if (targetPres) {
      session.currentPresentationId = targetPres;
      await this.ensurePresentationLoaded(session, targetPres);
    }

    if (historicalProblems.length === 0) return;

    const account = this.getFreshAccount(session);
    if (session.watchOnly || !account || !isAiReady(account.aiConfig)) return;
    const allowRetryExpired = Boolean(account.aiConfig?.autoRetryExpired);
    const nowMs = Date.now();

    for (const ev of historicalProblems) {
      const problemId = String(ev.prob ?? '').trim();
      if (!problemId) continue;
      if (
        this.db.isProblemAnswered(
          session.accountKey,
          session.lessonId,
          problemId
        )
      ) {
        continue;
      }

      const pPres =
        (typeof ev.pres === 'string' && ev.pres) ||
        session.currentPresentationId;
      const limit = asInt(ev.limit);
      const dt = asInt(ev.dt);

      let isExpired = false;
      let effectiveRemainingLimit: number | null = null;
      if (limit !== null && limit > 0 && dt !== null && dt > 0) {
        const elapsedSec = Math.floor((nowMs - dt) / 1000);
        const remaining = limit - elapsedSec;
        if (remaining <= 3) {
          isExpired = true;
        } else {
          effectiveRemainingLimit = remaining;
        }
      }
      if (isExpired && !allowRetryExpired) continue;

      session.problemUnlockedAt.set(
        problemId,
        dt && dt > 0 ? dt : Date.now()
      );
      if (effectiveRemainingLimit !== null) {
        session.problemLimits.set(problemId, effectiveRemainingLimit);
      } else if (limit !== null) {
        session.problemLimits.set(problemId, limit);
      }

      void this.processProblem({
        session,
        problemId,
        presentationId: pPres,
        limitSec: effectiveRemainingLimit ?? limit,
        problemDt: dt,
        isExpired,
      });
    }
  }

  private async ensurePresentationLoaded(
    session: InternalLessonSession,
    presentationId: string
  ): Promise<PresentationData | null> {
    const cached = session.presentations.get(presentationId);
    if (cached) return cached;

    const account = this.getFreshAccount(session);
    if (!account || !session.bearerToken) return null;
    try {
      const client = new RainClassroomClient(account);
      const pres = await client.getPresentation(
        session.bearerToken,
        presentationId
      );
      if (pres) {
        session.presentations.set(presentationId, pres);
        if (
          (!session.courseTitle || session.courseTitle === '雨课堂课堂') &&
          pres.title.trim()
        ) {
          session.courseTitle = pres.title.trim();
        }
      }
      return pres;
    } catch (err) {
      this.logger.warn(
        'rc-ws',
        `拉取 PPT 失败 (${presentationId}): ${String(err)}`
      );
      return null;
    }
  }

  private findProblemSlide(
    session: InternalLessonSession,
    problemId: string,
    preferredPresId: string | null
  ): { slide: PresentationSlide; problem: ProblemData; presId: string } | null {
    if (preferredPresId && session.presentations.has(preferredPresId)) {
      const pres = session.presentations.get(preferredPresId)!;
      for (const slide of pres.slides) {
        if (slide.problem?.problemId === problemId) {
          return { slide, problem: slide.problem, presId: preferredPresId };
        }
      }
    }
    for (const [presId, pres] of session.presentations.entries()) {
      for (const slide of pres.slides) {
        if (slide.problem?.problemId === problemId) {
          return { slide, problem: slide.problem, presId };
        }
      }
    }
    return null;
  }

  private async processProblem(params: {
    session: InternalLessonSession;
    problemId: string;
    presentationId: string | null;
    limitSec: number | null;
    problemDt: number | null;
    isExpired: boolean;
  }): Promise<void> {
    const {
      session,
      problemId,
      presentationId,
      limitSec,
      problemDt,
      isExpired,
    } = params;
    if (session.disposed || session.isFinished || session.paused) return;

    const account = this.getFreshAccount(session);
    if (!account || !isAiReady(account.aiConfig)) return;
    if (
      this.db.isProblemAnswered(
        session.accountKey,
        session.lessonId,
        problemId
      )
    ) {
      return;
    }
    if (session.inFlightProblemIds.has(problemId)) return;
    session.inFlightProblemIds.add(problemId);

    const unlockAtMs = session.problemUnlockedAt.get(problemId) ?? Date.now();

    try {
      if (presentationId) {
        await this.ensurePresentationLoaded(session, presentationId);
      }
      let match = this.findProblemSlide(session, problemId, presentationId);
      if (
        !match &&
        session.currentPresentationId &&
        session.currentPresentationId !== presentationId
      ) {
        await this.ensurePresentationLoaded(
          session,
          session.currentPresentationId
        );
        match = this.findProblemSlide(
          session,
          problemId,
          session.currentPresentationId
        );
      }

      if (!match) {
        this.logger.warn(
          'rc-ws',
          `未在 PPT 中找到题目 ${problemId} (${session.courseTitle})`
        );
        return;
      }

      const problem: ProblemData = {
        ...match.problem,
        dt: problemDt ?? match.problem.dt,
      };
      const solveResult = await solveProblemWithVisionAi({
        config: account.aiConfig,
        problem,
        slide: match.slide,
        courseTitle: session.courseTitle,
      });

      if (session.disposed || session.isFinished || session.paused) return;

      // 主观题分级保护
      if (problem.problemType === 5) {
        if (solveResult.requiresHandwritingOrPhoto) {
          this.db.addLog({
            accountKey: account.accountKey,
            accountName: account.name,
            platform: 'rainClassroom',
            category: 'ai_answer',
            level: 'warn',
            title: `主观题需拍照上传，已拦截提交《${session.courseTitle}》`,
            detail: `参考思路：${solveResult.textAnswer.slice(0, 200)}`,
            courseName: session.courseTitle,
            lessonId: session.lessonId,
            problemId,
          });
          return;
        }
        if (!account.aiConfig.autoSubmitSubjective) {
          this.db.addLog({
            accountKey: account.accountKey,
            accountName: account.name,
            platform: 'rainClassroom',
            category: 'ai_answer',
            level: 'info',
            title: `主观题草稿已备好（未自动提交）《${session.courseTitle}》`,
            detail: solveResult.textAnswer.slice(0, 260),
            courseName: session.courseTitle,
            lessonId: session.lessonId,
            problemId,
          });
          return;
        }
      }

      // 动态拟人延迟：8~18 秒随机，限时题倒计时 <12s 提前抢交
      const elapsedSec = Math.floor((Date.now() - unlockAtMs) / 1000);
      const targetTotalSec = 8 + Math.floor(Math.random() * 11); // 8..18
      let waitSec = isExpired ? 0 : Math.max(0, targetTotalSec - elapsedSec);
      const effectiveLimit = session.problemLimits.get(problemId) ?? limitSec;
      if (!isExpired && effectiveLimit !== null && effectiveLimit > 0) {
        const remainingLimit = effectiveLimit - elapsedSec;
        if (remainingLimit <= 12) {
          waitSec = 0;
        } else {
          waitSec = Math.min(waitSec, remainingLimit - 12);
        }
      }

      if (waitSec <= 0) {
        await this.executeSubmit(session, problem, solveResult, isExpired);
        return;
      }

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(() => {
          session.delayTimers.delete(problemId);
          finish();
        }, waitSec * 1000);
        session.delayTimers.set(problemId, () => {
          clearTimeout(timer);
          session.delayTimers.delete(problemId);
          finish();
        });
      });

      if (session.disposed || session.isFinished || session.paused) return;
      await this.executeSubmit(session, problem, solveResult, isExpired);
    } catch (err) {
      this.logger.warn(
        'rc-ws',
        `AI 解题异常 (${session.courseTitle} / ${problemId}): ${String(err)}`
      );
      this.db.addLog({
        accountKey: session.accountKey,
        accountName: session.accountName,
        platform: 'rainClassroom',
        category: 'ai_answer',
        level: 'error',
        title: `AI 自动答题失败《${session.courseTitle}》`,
        detail: String(err).slice(0, 240),
        courseName: session.courseTitle,
        lessonId: session.lessonId,
        problemId,
      });
    } finally {
      session.inFlightProblemIds.delete(problemId);
    }
  }

  private async executeSubmit(
    session: InternalLessonSession,
    problem: ProblemData,
    solveResult: AiSolveResult,
    isRetry: boolean
  ): Promise<void> {
    const account = this.getFreshAccount(session);
    if (!account || !session.bearerToken) return;

    const client = new RainClassroomClient(account);
    const resp = await client.submitAnswer(session.bearerToken, {
      problemId: problem.problemId,
      problemType: problem.problemType,
      retry: isRetry,
      options: problem.problemType === 5 ? undefined : solveResult.options,
      content: problem.problemType === 5 ? solveResult.textAnswer : undefined,
    });

    const code = asInt(resp.code);
    const ok = code === 0 || code === null;
    const answerSummary =
      problem.problemType === 5
        ? solveResult.textAnswer.slice(0, 120)
        : solveResult.options.join(', ');

    if (ok) {
      this.db.markProblemAnswered(
        session.accountKey,
        session.lessonId,
        problem.problemId
      );
      session.solvedCount++;
      session.lastActivityAt = formatUtc8Iso();
      this.db.addLog({
        accountKey: account.accountKey,
        accountName: account.name,
        platform: 'rainClassroom',
        category: 'ai_answer',
        level: 'success',
        title: `AI 已自动作答《${session.courseTitle}》`,
        detail: `答案：[${answerSummary}] · 耗时 ${solveResult.elapsedMs}ms${solveResult.reason ? ` · 依据：${solveResult.reason}` : ''}`,
        courseName: session.courseTitle,
        lessonId: session.lessonId,
        problemId: problem.problemId,
      });
    } else {
      this.db.addLog({
        accountKey: account.accountKey,
        accountName: account.name,
        platform: 'rainClassroom',
        category: 'ai_answer',
        level: 'warn',
        title: `提交答案返回异常 (code=${code})《${session.courseTitle}》`,
        detail: `尝试提交 [${answerSummary}]，返回：${JSON.stringify(resp).slice(0, 180)}`,
        courseName: session.courseTitle,
        lessonId: session.lessonId,
        problemId: problem.problemId,
      });
    }
  }

  private finishSession(session: InternalLessonSession): void {
    if (session.isFinished) return;
    session.isFinished = true;
    this.finishedKeys.add(session.sessionKey);
    if (!session.watchOnly) {
      this.db.addLog({
        accountKey: session.accountKey,
        accountName: session.accountName,
        platform: 'rainClassroom',
        category: 'session',
        level: 'info',
        title: `已下课，结束云端托管《${session.courseTitle}》`,
        detail: `本堂课 AI 共自动完成 ${session.solvedCount} 道题`,
        courseName: session.courseTitle,
        lessonId: session.lessonId,
      });
    }
    this.disposeSession(session);
    this.sessions.delete(session.sessionKey);
    this.onLessonFinishedCallback?.(
      session.accountKey,
      session.lessonId,
      session.courseId
    );
  }

  private disposeSession(session: InternalLessonSession): void {
    session.disposed = true;
    session.isConnected = false;
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
    if (session.healthTimer) {
      clearInterval(session.healthTimer);
      session.healthTimer = null;
    }
    for (const cancel of session.delayTimers.values()) {
      cancel();
    }
    session.delayTimers.clear();
    if (session.ws) {
      try {
        session.ws.removeAllListeners();
        session.ws.close();
      } catch {
        // ignore
      }
      session.ws = null;
    }
  }
}

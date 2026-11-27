import { resolveLocationForSignIn } from '../campus.js';
import type { AppConfig, Logger } from '../config.js';
import type { CloudDatabase } from '../db.js';
import { ChaoXingClient } from '../protocols/chaoxing.js';
import {
  RainClassroomClient,
  requiresPendingLocationSignIn,
  SessionExpiredError,
} from '../protocols/rainclassroom.js';
import {
  academicWeekForEpoch,
  computeSlotEpochsUtc8,
  getUtc8Parts,
} from '../time.js';
import {
  normalizeCourseName,
  type OnlineCourse,
  type SignReservation,
  type StoredAccount,
  type TimetableCourse,
} from '../types.js';
import type { RcAutoAnswerEngine } from './rc_auto_answer.js';

interface WatchSlot {
  course: TimetableCourse;
  reservation: SignReservation;
  week: number;
  dateKey: string;
  triggerEpochMs: number;
  endEpochMs: number;
}

interface CourseCacheEntry {
  fetchedAt: number;
  courses: OnlineCourse[];
}

export function fuzzyMatchOnlineCourse(
  timetableName: string,
  online: OnlineCourse[]
): OnlineCourse | null {
  if (!online.length) return null;
  const target = normalizeCourseName(timetableName);
  if (!target) return null;

  for (const c of online) {
    if (normalizeCourseName(c.name) === target) return c;
  }
  for (const c of online) {
    const norm = normalizeCourseName(c.name);
    if (norm && (norm.includes(target) || target.includes(norm))) {
      return c;
    }
  }
  return null;
}

export class CloudSchedulerEngine {
  private pollTimer: NodeJS.Timeout | null = null;
  private exactTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private readonly courseCache = new Map<string, CourseCacheEntry>();
  private readonly loggedManualActives = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: CloudDatabase,
    private readonly rcAutoAnswer: RcAutoAnswerEngine,
    private readonly logger: Logger
  ) {}

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, this.config.pollIntervalMs);
    this.pruneTimer = setInterval(() => {
      this.pruneStaleDevicesNow();
    }, 60 * 60 * 1000);
    this.pruneStaleDevicesNow();
    this.refreshExactTrigger();
    void this.tick();
    this.logger.info(
      'scheduler',
      `云端多账号调度引擎已启动（轮询间隔 ${this.config.pollIntervalMs}ms）`
    );
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.exactTimer) {
      clearTimeout(this.exactTimer);
      this.exactTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  pruneStaleDevicesNow(maxAgeMs = 14 * 24 * 60 * 60 * 1000): void {
    try {
      const { prunedBindings, stoppedAccountKeys } =
        this.db.pruneStaleDevices(maxAgeMs);
      for (const accKey of stoppedAccountKeys) {
        this.rcAutoAnswer.detachAccount(accKey);
      }
      if (prunedBindings > 0 || stoppedAccountKeys.length > 0) {
        this.logger.info(
          'scheduler',
          `已清理超期设备绑定=${prunedBindings}，自动停服账号=${stoppedAccountKeys.length}`
        );
      }
    } catch (err) {
      this.logger.warn('scheduler', `清理超期设备绑定异常: ${String(err)}`);
    }
  }

  onWorkspaceUpdated(): void {
    this.refreshExactTrigger();
    void this.tick();
  }

  private getTodayWatchSlotsForAccount(
    account: StoredAccount,
    nowMs: number
  ): WatchSlot[] {
    if (account.sessionStatus === 'session_expired') return [];
    if (!account.reservations.length || !account.timetable.length) return [];

    const semesterStart =
      account.semesterStartMonday || this.config.semesterStartMonday;
    const todayParts = getUtc8Parts(nowMs);
    const currentWeek = academicWeekForEpoch(semesterStart, nowMs);

    const courseById = new Map<string, TimetableCourse>();
    for (const c of account.timetable) {
      courseById.set(c.id, c);
    }

    const slots: WatchSlot[] = [];
    for (const res of account.reservations) {
      if (!res.enabled) continue;
      const course = courseById.get(res.timetableCourseId);
      if (!course) continue;
      if (course.weekday !== todayParts.weekday) continue;
      if (!course.weeks.includes(currentWeek)) continue;
      if (res.targetWeek !== null && res.targetWeek !== currentWeek) continue;

      const { triggerEpochMs, endEpochMs, dateKey } = computeSlotEpochsUtc8(
        semesterStart,
        course,
        res,
        currentWeek
      );
      slots.push({
        course,
        reservation: res,
        week: currentWeek,
        dateKey,
        triggerEpochMs,
        endEpochMs,
      });
    }
    return slots;
  }

  /**
   * 整点第 0 秒精准唤醒：查找所有账号下一个即将到来的触发时刻。
   */
  refreshExactTrigger(): void {
    if (this.exactTimer) {
      clearTimeout(this.exactTimer);
      this.exactTimer = null;
    }

    const nowMs = Date.now();
    const accounts = this.db.getAllAccounts();
    let earliestFutureMs: number | null = null;

    for (const acc of accounts) {
      const slots = this.getTodayWatchSlotsForAccount(acc, nowMs);
      for (const slot of slots) {
        if (slot.triggerEpochMs > nowMs) {
          if (
            earliestFutureMs === null ||
            slot.triggerEpochMs < earliestFutureMs
          ) {
            earliestFutureMs = slot.triggerEpochMs;
          }
        }
      }
    }

    if (earliestFutureMs === null) return;
    const waitMs = Math.min(10 * 60 * 1000, Math.max(50, earliestFutureMs - nowMs));
    this.exactTimer = setTimeout(() => {
      this.exactTimer = null;
      void this.tick();
      this.refreshExactTrigger();
    }, waitMs);
  }

  async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      const nowMs = Date.now();
      const accounts = this.db.getAllAccounts();

      // 按账号独立并发处理，单账号异常互不影响
      await Promise.allSettled(
        accounts.map((acc) => this.processAccount(acc, nowMs))
      );
    } catch (err) {
      this.logger.error('scheduler', `调度巡检异常: ${String(err)}`);
    } finally {
      this.isTicking = false;
      this.refreshExactTrigger();
    }
  }

  private async processAccount(
    account: StoredAccount,
    nowMs: number
  ): Promise<void> {
    const slots = this.getTodayWatchSlotsForAccount(account, nowMs);
    if (!slots.length) return;

    // 课前 5 分钟预热已选课程列表缓存
    const needPrefetch = slots.some(
      (s) =>
        nowMs >= s.triggerEpochMs - 5 * 60 * 1000 &&
        nowMs <= s.endEpochMs
    );
    const activeSlots = slots.filter(
      (s) => nowMs >= s.triggerEpochMs && nowMs <= s.endEpochMs
    );

    if (!needPrefetch && !activeSlots.length) return;

    try {
      if (account.platform === 'rainClassroom') {
        await this.processRainClassroomAccount(
          account,
          activeSlots,
          needPrefetch,
          nowMs
        );
      } else {
        await this.processChaoXingAccount(
          account,
          activeSlots,
          needPrefetch,
          nowMs
        );
      }
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
          platform: account.platform,
          category: 'session',
          level: 'error',
          title: `账号 ${account.name} 登录态已过期`,
          detail: `${err.message}，请打开 App 重新登录以恢复云端自动签到`,
        });
        return;
      }
      this.logger.warn(
        'scheduler',
        `账号 ${account.accountKey} 巡检失败: ${String(err)}`
      );
    }
  }

  private async getCachedCourses(
    account: StoredAccount,
    fetcher: () => Promise<OnlineCourse[]>,
    nowMs: number
  ): Promise<OnlineCourse[]> {
    const cacheKey = account.accountKey;
    const hit = this.courseCache.get(cacheKey);
    if (hit && nowMs - hit.fetchedAt < 3 * 60 * 1000 && hit.courses.length > 0) {
      return hit.courses;
    }
    const fresh = await fetcher();
    if (fresh.length > 0) {
      this.courseCache.set(cacheKey, { fetchedAt: nowMs, courses: fresh });
    }
    return fresh;
  }

  private async processRainClassroomAccount(
    account: StoredAccount,
    activeSlots: WatchSlot[],
    needPrefetch: boolean,
    nowMs: number
  ): Promise<void> {
    const client = new RainClassroomClient(account, (cookies) => {
      this.db.updateAccountCookies(account.accountKey, cookies);
    });

    let enrolledCourses: OnlineCourse[] = [];
    if (needPrefetch) {
      enrolledCourses = await this.getCachedCourses(
        account,
        () => client.getAllEnrolledCourses(),
        nowMs
      );
    }
    if (!activeSlots.length) return;

    // 协议要点：到点实时零缓存直查 getOnLesson
    const onLessons = await client.getOnLesson();
    if (!onLessons.length) return;

    for (const slot of activeSlots) {
      const boundCourseId = slot.reservation.boundOnlineCourseId?.trim() || null;
      const boundClassId = slot.reservation.boundOnlineClassId?.trim() || null;

      let matchedLessonId: string | null = null;
      let matchedCourseId: string | null = null;

      // 1. 精确绑定 ID 匹配
      if (boundCourseId) {
        for (const item of onLessons) {
          const courseMatch = item.courseId === boundCourseId;
          const classMatch = !boundClassId || item.classroomId === boundClassId;
          if (courseMatch && classMatch) {
            matchedLessonId = item.lessonId;
            matchedCourseId = item.courseId;
            break;
          }
        }
      }

      // 2. 通过已选课反查绑定 ID 再匹配 onLessons
      if (!matchedLessonId && enrolledCourses.length > 0) {
        const enrolledHit = fuzzyMatchOnlineCourse(
          slot.course.name,
          enrolledCourses
        );
        if (enrolledHit) {
          for (const item of onLessons) {
            if (item.courseId === enrolledHit.courseId) {
              matchedLessonId = item.lessonId;
              matchedCourseId = item.courseId;
              break;
            }
          }
        }
      }

      // 3. 直接对实时 onLessons 课程名模糊匹配
      if (!matchedLessonId) {
        const liveCandidates: OnlineCourse[] = onLessons.map((item) => ({
          courseId: item.courseId,
          classId: item.classroomId,
          name: item.courseName,
          teacher: '',
          lessonId: item.lessonId,
        }));
        const fuzzyHit = fuzzyMatchOnlineCourse(
          slot.course.name,
          liveCandidates
        );
        if (fuzzyHit) {
          matchedCourseId = fuzzyHit.courseId;
          matchedLessonId = fuzzyHit.lessonId ?? null;
        }
      }

      if (!matchedLessonId) continue;

      const targetCourseId = matchedCourseId ?? boundCourseId ?? '';
      const alreadySigned = this.db.isReservationSigned(
        account.accountKey,
        slot.reservation.id,
        slot.dateKey
      );

      if (alreadySigned) {
        // 连堂课下半场巡检：新开且未托管/未下课的 lessonId 自动二次进班续挂 AI
        if (
          this.rcAutoAnswer.isWatching(account.accountKey, matchedLessonId) ||
          this.rcAutoAnswer.isLessonFinished(account.accountKey, matchedLessonId)
        ) {
          continue;
        }
        const recheck = await client.checkIn(matchedLessonId);
        if (recheck.code === 0) {
          this.db.addLog({
            accountKey: account.accountKey,
            accountName: account.name,
            platform: 'rainClassroom',
            category: 'checkin',
            level: 'success',
            title: `连堂课自动续签进班《${slot.course.name}》`,
            detail: `检测到下半场新课堂 (${matchedLessonId})，已自动进班续挂`,
            courseName: slot.course.name,
            lessonId: matchedLessonId,
          });
          await this.rcAutoAnswer.attachLesson({
            account,
            lessonId: matchedLessonId,
            courseId: targetCourseId,
            courseTitle: slot.course.name,
            classroom: slot.course.classroom,
            bearerToken: recheck.bearerToken,
            lessonToken: recheck.lessonToken,
          });
        }
        continue;
      }

      // 首次进班签到（source: 21）
      const checkRes = await client.checkIn(matchedLessonId);
      if (checkRes.code !== 0) {
        this.logger.warn(
          'scheduler',
          `雨课堂进班签到异常 code=${checkRes.code} course=${slot.course.name}`
        );
        continue;
      }

      let signDetail = '云端免扫码进班签到成功';

      // 检查是否需要定位签到（傻瓜式开箱全自动完成！）
      if (checkRes.bearerToken) {
        const eligibility = await client.getLocationCheckInEligibility(
          checkRes.bearerToken
        );
        if (requiresPendingLocationSignIn(eligibility)) {
          const preset = targetCourseId
            ? account.courseLocations[targetCourseId] ?? null
            : null;
          const loc = resolveLocationForSignIn({
            targetCoord: 'gcj02',
            preset,
            teacherLat: eligibility?.centerLat,
            teacherLng: eligibility?.centerLng,
            teacherAddress: eligibility?.address,
            classroom: slot.course.classroom,
          });
          const submitRes = await client.submitLocationCheckIn(
            checkRes.bearerToken,
            matchedLessonId,
            loc.latitude,
            loc.longitude,
            loc.address
          );
          if (Number(submitRes.code) === 0) {
            signDetail = `云端自动定位签到成功 (${loc.address})`;
          } else {
            this.db.addLog({
              accountKey: account.accountKey,
              accountName: account.name,
              platform: 'rainClassroom',
              category: 'location',
              level: 'warn',
              title: `定位签到提交返回异常《${slot.course.name}》`,
              detail: `地址：${loc.address}，返回：${JSON.stringify(submitRes).slice(0, 160)}`,
              courseName: slot.course.name,
              lessonId: matchedLessonId,
            });
            continue;
          }
        }
      }

      this.db.markReservationSigned(
        account.accountKey,
        slot.reservation.id,
        slot.dateKey,
        signDetail
      );
      this.db.addLog({
        accountKey: account.accountKey,
        accountName: account.name,
        platform: 'rainClassroom',
        category: 'checkin',
        level: 'success',
        title: `自动签到成功《${slot.course.name}》`,
        detail: `${signDetail} · 账号 ${account.name}`,
        courseName: slot.course.name,
        lessonId: matchedLessonId,
      });

      // 自动接管 AI 视觉答题（仅当该账号配置了 AI）
      await this.rcAutoAnswer.attachLesson({
        account,
        lessonId: matchedLessonId,
        courseId: targetCourseId,
        courseTitle: slot.course.name,
        classroom: slot.course.classroom,
        bearerToken: checkRes.bearerToken,
        lessonToken: checkRes.lessonToken,
      });
    }
  }

  private async processChaoXingAccount(
    account: StoredAccount,
    activeSlots: WatchSlot[],
    needPrefetch: boolean,
    nowMs: number
  ): Promise<void> {
    const client = new ChaoXingClient(account, (cookies) => {
      this.db.updateAccountCookies(account.accountKey, cookies);
    });

    const courses = needPrefetch
      ? await this.getCachedCourses(
          account,
          () => client.getCoursesList(),
          nowMs
        )
      : [];
    if (!activeSlots.length || !courses.length) return;

    for (const slot of activeSlots) {
      if (
        this.db.isReservationSigned(
          account.accountKey,
          slot.reservation.id,
          slot.dateKey
        )
      ) {
        continue;
      }

      let matched: OnlineCourse | null = null;
      const boundId = slot.reservation.boundOnlineCourseId?.trim();
      if (boundId) {
        matched = courses.find((c) => c.courseId === boundId) ?? null;
      }
      matched ??= fuzzyMatchOnlineCourse(slot.course.name, courses);
      if (!matched) continue;

      const cpi = matched.cpi || slot.reservation.boundOnlineCpi || '';
      const actives = await client.getOngoingSignActives(
        matched.courseId,
        matched.classId,
        cpi
      );
      if (!actives.length) continue;

      for (const active of actives) {
        const already = await client.isAlreadySigned(active.id);
        if (already) {
          this.db.markReservationSigned(
            account.accountKey,
            slot.reservation.id,
            slot.dateKey,
            '检测到已完成签到'
          );
          break;
        }

        const detail = await client.getActiveDetail(active.id);
        if (!detail) continue;

        if (detail.otherId === 0 && !detail.needPhoto && !detail.needCaptcha) {
          const text = await client.normalSign(
            matched.courseId,
            active.id,
            active.url
          );
          if (
            text.includes('success') ||
            text.includes('已签到') ||
            text.includes('签到成功')
          ) {
            this.db.markReservationSigned(
              account.accountKey,
              slot.reservation.id,
              slot.dateKey,
              '学习通普通签到成功'
            );
            this.db.addLog({
              accountKey: account.accountKey,
              accountName: account.name,
              platform: 'chaoxing',
              category: 'checkin',
              level: 'success',
              title: `学习通自动签到成功《${slot.course.name}》`,
              detail: `普通签到成功 (${active.name}) · 账号 ${account.name}`,
              courseName: slot.course.name,
            });
            break;
          }
        } else if (
          detail.otherId === 4 &&
          !detail.needFace &&
          !detail.needCaptcha
        ) {
          const preset = account.courseLocations[matched.courseId] ?? null;
          const loc = resolveLocationForSignIn({
            targetCoord: 'bd09',
            preset,
            teacherLat: detail.locationLat,
            teacherLng: detail.locationLng,
            teacherAddress: detail.locationText,
            classroom: slot.course.classroom,
          });
          const text = await client.locationSign(
            matched.courseId,
            active.id,
            loc.address,
            loc.latitude,
            loc.longitude,
            active.url
          );
          if (
            text.includes('success') ||
            text.includes('已签到') ||
            text.includes('签到成功')
          ) {
            this.db.markReservationSigned(
              account.accountKey,
              slot.reservation.id,
              slot.dateKey,
              `学习通自动定位签到成功 (${loc.address})`
            );
            this.db.addLog({
              accountKey: account.accountKey,
              accountName: account.name,
              platform: 'chaoxing',
              category: 'location',
              level: 'success',
              title: `学习通定位签到成功《${slot.course.name}》`,
              detail: `已自动提交定位 (${loc.address}, 来源: ${loc.source}) · 账号 ${account.name}`,
              courseName: slot.course.name,
            });
            break;
          }
        } else {
          // 手势、签到码、二维码、拍照或人脸签到需要人工介入
          const warnKey = `${account.accountKey}:${active.id}`;
          if (!this.loggedManualActives.has(warnKey)) {
            this.loggedManualActives.add(warnKey);
            const reason = detail.needPhoto
              ? '拍照签到'
              : detail.needFace
                ? '人脸识别签到'
                : detail.otherId === 3
                  ? '手势签到'
                  : detail.otherId === 5
                    ? '签到码签到'
                    : detail.otherId === 2
                      ? '二维码签到'
                      : '需要人工验证的签到';
            this.db.addLog({
              accountKey: account.accountKey,
              accountName: account.name,
              platform: 'chaoxing',
              category: 'checkin',
              level: 'warn',
              title: `检测到${reason}《${slot.course.name}》`,
              detail: `该类型无法云端代签，请在 App 内手动处理 (${active.name})`,
              courseName: slot.course.name,
            });
          }
        }
      }
    }
  }
}

import http from 'node:http';
import { isAiReady, testVisionConnection } from './ai/vision_solver.js';
import type { AppConfig, Logger } from './config.js';
import { safeEqual } from './crypto.js';
import {
  CloudDatabase,
  type DeviceMeta,
  hasNonEmptyConfig,
  parseCookieInput,
} from './db.js';
import type { RcAutoAnswerEngine } from './engines/rc_auto_answer.js';
import type { CloudSchedulerEngine } from './engines/scheduler.js';
import {
  defaultOwnershipVerifier,
  isCanonicalAccountKeyMatch,
  matchesStoredSessionToken,
  type OwnershipVerifier,
} from './protocols/ownership.js';
import { RainClassroomClient } from './protocols/rainclassroom.js';
import {
  computeClassSessionGuardExpiryUtc8,
  formatUtc8Iso,
  getUtc8Parts,
} from './time.js';
import type {
  AiConfig,
  CloudSyncRequest,
  PullSyncRequest,
  PushAccountConfigRequest,
  RainClassroomServerType,
  RcLessonGuardLocation,
  ReportRcLessonGuardRequest,
  StoredAccount,
} from './types.js';

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, X-Access-Code, X-Device-Id, X-Device-Name, X-User-Token, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(payload);
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 2 * 1024 * 1024) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function decodeHeaderValue(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function buildAccountHealthSnapshot(
  db: CloudDatabase,
  account: StoredAccount,
  currentDeviceId: string
) {
  const boundDevices = db.getBoundDevices(account.accountKey, currentDeviceId);
  const primaryDeviceId = db.selectPrimaryDeviceId(account.accountKey);
  return {
    accountKey: account.accountKey,
    platform: account.platform,
    server: account.server,
    uid: account.uid,
    name: account.name,
    sessionStatus: account.sessionStatus,
    sessionError: account.sessionError,
    reservationCount: account.reservations.filter((r) => r.enabled).length,
    timetableCount: account.timetable.length,
    aiEnabled: Boolean(account.aiConfig?.enabled),
    configRev: account.configRev,
    configUpdatedAt: account.configUpdatedAt,
    updatedAt: account.updatedAt,
    boundDevices,
    isPrimaryFallback: primaryDeviceId === currentDeviceId,
  };
}

export function createCloudServer(deps: {
  config: AppConfig;
  db: CloudDatabase;
  rcAutoAnswer: RcAutoAnswerEngine;
  scheduler: CloudSchedulerEngine;
  logger: Logger;
  startedAtMs?: number;
  ownershipVerifier?: OwnershipVerifier;
}): http.Server {
  const {
    config,
    db,
    rcAutoAnswer,
    scheduler,
    logger,
    startedAtMs = Date.now(),
    ownershipVerifier = defaultOwnershipVerifier,
  } = deps;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers':
            'Content-Type, X-Access-Code, X-Device-Id, X-Device-Name, X-User-Token, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // 1. 公开存活探针
      if (req.method === 'GET' && pathname === '/health') {
        const stats = db.getStats();
        sendJson(res, 200, {
          ok: true,
          service: 'course-helper-cloud',
          apiVersion: 2,
          capabilities: ['rc_lesson_guard'],
          uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
          activeSessions: rcAutoAnswer.getActiveCount(),
          trackedWorkspaces: stats.workspaces,
          trackedAccounts: stats.accounts,
          boundDeviceCount: stats.devices,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
        });
        return;
      }

      // 2. 鉴权校验（所有 /api/* 接口）
      const accessCode = String(req.headers['x-access-code'] ?? '').trim();
      if (!accessCode || !safeEqual(accessCode, config.accessCode)) {
        sendJson(res, 401, { ok: false, error: '无效的云端访问口令' });
        return;
      }

      const deviceId = String(
        req.headers['x-device-id'] ?? req.headers['x-user-token'] ?? ''
      ).trim();
      if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
        sendJson(res, 400, {
          ok: false,
          error: '缺少或格式非法的设备标识 (X-Device-Id / X-User-Token)',
        });
        return;
      }
      const headerDeviceName = decodeHeaderValue(req.headers['x-device-name']);

      // 3. POST /api/v2/sync/pull - 多设备零配置拉取、归属核验与设备绑定
      if (req.method === 'POST' && pathname === '/api/v2/sync/pull') {
        const body = await readJsonBody<PullSyncRequest>(req);
        if (!Array.isArray(body.accounts)) {
          sendJson(res, 400, { ok: false, error: 'accounts 必须为数组' });
          return;
        }

        const deviceMeta: DeviceMeta = {
          deviceId,
          deviceName: (body.deviceName ?? '').trim() || headerDeviceName,
          platformOs: body.platformOs,
          isTablet:
            typeof body.isTablet === 'boolean' ? body.isTablet : undefined,
        };

        const pulledAccounts: Record<
          string,
          {
            status: 'ok' | 'created' | 'relogin_required' | 'ownership_denied';
            configRev: number;
            unchanged: boolean;
            error?: string;
            config?: {
              semesterStartMonday: string | null;
              timetable: StoredAccount['timetable'];
              reservations: StoredAccount['reservations'];
              courseLocations: StoredAccount['courseLocations'];
              aiConfig: StoredAccount['aiConfig'];
            };
          }
        > = {};

        let createdAny = false;
        let refreshedAny = false;

        for (const item of body.accounts) {
          const accountKey = (item.accountKey ?? '').trim();
          const uid = String(item.uid ?? '').trim();
          if (!accountKey || !uid) continue;

          const server: RainClassroomServerType = item.server ?? 'yuketang';
          if (
            !isCanonicalAccountKeyMatch(accountKey, item.platform, server, uid)
          ) {
            pulledAccounts[accountKey] = {
              status: 'ownership_denied',
              configRev: 0,
              unchanged: true,
              error: 'accountKey 与平台/UID 不匹配',
            };
            continue;
          }

          const incomingCookies = parseCookieInput(item.cookies);
          const existing = db.getAccount(accountKey);

          if (!existing) {
            // 首次建档也必须校验归属，防止恶意抢注他人尚未上云的 accountKey
            const verifyNew = await ownershipVerifier({
              accountKey,
              platform: item.platform,
              server,
              uid,
              cookies: incomingCookies,
              existingAccount: null,
            });
            if (!verifyNew.ok) {
              pulledAccounts[accountKey] = {
                status: verifyNew.expired
                  ? 'relogin_required'
                  : 'ownership_denied',
                configRev: 0,
                unchanged: true,
                error: verifyNew.reason ?? '账号归属验证未通过',
              };
              continue;
            }

            const seeded = db.seedNewAccount({
              accountKey,
              platform: item.platform,
              server,
              uid,
              name: item.name,
              cookies: incomingCookies,
              cookiesUpdatedAt: item.cookiesUpdatedAt,
              deviceInfo: item.deviceInfo,
              config: item.initialConfig ?? null,
              device: deviceMeta,
            });
            createdAny = true;
            if (seeded.created) {
              pulledAccounts[accountKey] = {
                status: 'created',
                configRev: seeded.account.configRev,
                unchanged: true,
              };
            } else {
              pulledAccounts[accountKey] = {
                status: 'ok',
                configRev: seeded.account.configRev,
                unchanged: false,
                config: {
                  semesterStartMonday: seeded.account.semesterStartMonday,
                  timetable: seeded.account.timetable,
                  reservations: db.getMergedReservationsForAccount(
                    seeded.account
                  ),
                  courseLocations: seeded.account.courseLocations,
                  aiConfig: seeded.account.aiConfig,
                },
              };
            }
            continue;
          }

          if (
            existing.platform !== item.platform ||
            String(existing.uid) !== uid ||
            (existing.platform === 'rainClassroom' && existing.server !== server)
          ) {
            pulledAccounts[accountKey] = {
              status: 'ownership_denied',
              configRev: existing.configRev,
              unchanged: true,
              error: '账号身份元信息不一致',
            };
            continue;
          }

          const alreadyBound = db.isDeviceBound(accountKey, deviceId);
          if (!alreadyBound) {
            const verify = await ownershipVerifier({
              accountKey,
              platform: existing.platform,
              server: existing.server,
              uid: existing.uid,
              cookies: incomingCookies,
              existingAccount: existing,
            });
            if (!verify.ok) {
              pulledAccounts[accountKey] = {
                status: verify.expired ? 'relogin_required' : 'ownership_denied',
                configRev: existing.configRev,
                unchanged: true,
                error: verify.reason ?? '账号归属验证未通过',
              };
              continue;
            }
            db.bindOrTouchDevice(accountKey, deviceMeta);
            if (
              Object.keys(incomingCookies).length > 0 &&
              db.refreshAccountCookiesIfFresher({
                accountKey,
                cookies: incomingCookies,
                cookiesUpdatedAt: item.cookiesUpdatedAt,
                deviceInfo: item.deviceInfo,
                name: item.name,
                forceAccept: existing.sessionStatus !== 'ok',
              })
            ) {
              refreshedAny = true;
            }
          } else {
            db.bindOrTouchDevice(accountKey, deviceMeta);
            const hasIncCookies = Object.keys(incomingCookies).length > 0;
            const wantsCookieRefresh =
              hasIncCookies &&
              ((item.cookiesUpdatedAt ?? 0) > existing.cookiesUpdatedAt ||
                existing.sessionStatus !== 'ok' ||
                Object.keys(existing.cookies).length === 0);

            if (wantsCookieRefresh) {
              let canAccept = matchesStoredSessionToken(
                existing.platform,
                existing.uid,
                incomingCookies,
                existing
              );
              if (!canAccept) {
                const verify = await ownershipVerifier({
                  accountKey,
                  platform: existing.platform,
                  server: existing.server,
                  uid: existing.uid,
                  cookies: incomingCookies,
                  existingAccount: existing,
                });
                canAccept = verify.ok;
              }
              if (
                canAccept &&
                db.refreshAccountCookiesIfFresher({
                  accountKey,
                  cookies: incomingCookies,
                  cookiesUpdatedAt: item.cookiesUpdatedAt,
                  deviceInfo: item.deviceInfo,
                  name: item.name,
                  forceAccept: existing.sessionStatus !== 'ok',
                })
              ) {
                refreshedAny = true;
              }
            }
          }

          const fresh = db.getAccount(accountKey)!;
          const knownRev = Number(item.knownRev ?? 0);
          const unchanged = alreadyBound && knownRev === fresh.configRev;
          pulledAccounts[accountKey] = {
            status: 'ok',
            configRev: fresh.configRev,
            unchanged,
            ...(unchanged
              ? {}
              : {
                  config: {
                    semesterStartMonday: fresh.semesterStartMonday,
                    timetable: fresh.timetable,
                    reservations: db.getMergedReservationsForAccount(fresh),
                    courseLocations: fresh.courseLocations,
                    aiConfig: fresh.aiConfig,
                  },
                }),
          };
        }

        if (createdAny || refreshedAny) {
          scheduler.onWorkspaceUpdated();
        }

        const boundAccounts = db.getAccountsForDevice(deviceId);
        const boundKeys = boundAccounts.map((a) => a.accountKey);
        const logLimit = Number(body.logLimit ?? 80) || 80;

        sendJson(res, 200, {
          ok: true,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
          pulledAccounts,
          accounts: boundAccounts.map((a) =>
            buildAccountHealthSnapshot(db, a, deviceId)
          ),
          activeSessions: rcAutoAnswer.getSessionsForAccounts(boundKeys),
          activeGuards: db.getActiveRcLessonGuardsForAccounts(boundKeys),
          signedRecords: db.getSignedMapForAccounts(boundKeys),
          logs: db.getLogsForAccounts(boundKeys, logLimit),
        });
        return;
      }

      // 4. POST /api/v2/accounts/:accountKey/config - 显式写入单账号配置（递增 configRev）
      const pushConfigMatch = /^\/api\/v2\/accounts\/([^/]+)\/config$/.exec(
        pathname
      );
      if (req.method === 'POST' && pushConfigMatch) {
        const accountKey = decodeURIComponent(pushConfigMatch[1]).trim();
        const body = await readJsonBody<PushAccountConfigRequest>(req);
        const uid = String(body.uid ?? '').trim();
        if (!accountKey || !uid) {
          sendJson(res, 400, { ok: false, error: '缺少 accountKey 或 uid' });
          return;
        }

        const server: RainClassroomServerType = body.server ?? 'yuketang';
        if (
          !isCanonicalAccountKeyMatch(accountKey, body.platform, server, uid)
        ) {
          sendJson(res, 400, {
            ok: false,
            error: 'accountKey 与平台/UID 不匹配',
          });
          return;
        }

        const deviceMeta: DeviceMeta = {
          deviceId,
          deviceName: (body.deviceName ?? '').trim() || headerDeviceName,
          platformOs: body.platformOs,
          isTablet:
            typeof body.isTablet === 'boolean' ? body.isTablet : undefined,
        };
        const incomingCookies = parseCookieInput(body.cookies);
        const existing = db.getAccount(accountKey);

        if (existing) {
          if (
            existing.platform !== body.platform ||
            String(existing.uid) !== uid ||
            (existing.platform === 'rainClassroom' && existing.server !== server)
          ) {
            sendJson(res, 403, { ok: false, error: '账号身份元信息不一致' });
            return;
          }
          if (!db.isDeviceBound(accountKey, deviceId)) {
            const verify = await ownershipVerifier({
              accountKey,
              platform: existing.platform,
              server: existing.server,
              uid: existing.uid,
              cookies: incomingCookies,
              existingAccount: existing,
            });
            if (!verify.ok) {
              sendJson(res, 403, {
                ok: false,
                error: verify.reason ?? '未授权修改该账号配置',
                expired: Boolean(verify.expired),
              });
              return;
            }
          }
        } else {
          const verifyNew = await ownershipVerifier({
            accountKey,
            platform: body.platform,
            server,
            uid,
            cookies: incomingCookies,
            existingAccount: null,
          });
          if (!verifyNew.ok) {
            sendJson(res, 403, {
              ok: false,
              error: verifyNew.reason ?? '未授权创建该账号配置',
              expired: Boolean(verifyNew.expired),
            });
            return;
          }
        }

        // 防过期 Cookie 覆盖云端有效 Cookie
        let safeCookies: Record<string, string> | undefined =
          Object.keys(incomingCookies).length > 0 ? incomingCookies : undefined;
        if (existing && safeCookies) {
          const wantsRefresh =
            (body.cookiesUpdatedAt ?? 0) > existing.cookiesUpdatedAt ||
            existing.sessionStatus !== 'ok' ||
            Object.keys(existing.cookies).length === 0;
          if (!wantsRefresh) {
            safeCookies = undefined;
          } else if (
            !matchesStoredSessionToken(
              existing.platform,
              existing.uid,
              safeCookies,
              existing
            )
          ) {
            const verify = await ownershipVerifier({
              accountKey,
              platform: existing.platform,
              server: existing.server,
              uid: existing.uid,
              cookies: safeCookies,
              existingAccount: existing,
            });
            if (!verify.ok) {
              safeCookies = undefined;
            }
          }
        }

        const updated = db.updateAccountConfig({
          accountKey,
          platform: body.platform,
          server,
          uid,
          name: body.name,
          cookies: safeCookies,
          cookiesUpdatedAt: body.cookiesUpdatedAt,
          deviceInfo: body.deviceInfo,
          semesterStartMonday: body.semesterStartMonday,
          timetable: Array.isArray(body.timetable) ? body.timetable : [],
          reservations: Array.isArray(body.reservations) ? body.reservations : [],
          courseLocations: body.courseLocations,
          aiConfig: body.aiConfig,
          allowClearApiKey: Boolean(body.allowClearApiKey),
          device: deviceMeta,
        });

        let detachedSessions = 0;
        if (!updated.aiConfig?.enabled) {
          detachedSessions = rcAutoAnswer.detachAccount(accountKey);
        }

        scheduler.onWorkspaceUpdated();
        logger.info(
          'api',
          `账号配置已更新 account=${accountKey} rev=${updated.configRev} device=${deviceId.slice(0, 8)}...`
        );

        sendJson(res, 200, {
          ok: true,
          accountKey,
          configRev: updated.configRev,
          detachedSessions,
          updatedAt: updated.updatedAt,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
        });
        return;
      }

      // 4.5 POST /api/v2/accounts/:accountKey/rc-lesson-guard - 上报雨课堂已签课堂，开启本堂课防试探重开护航
      const guardMatch =
        /^\/api\/v2\/accounts\/([^/]+)\/rc-lesson-guard$/.exec(pathname);
      if (req.method === 'POST' && guardMatch) {
        const accountKey = decodeURIComponent(guardMatch[1]).trim();
        const existing = db.getAccount(accountKey);
        if (!existing) {
          sendJson(res, 404, { ok: false, error: '云端尚无该账号，请先完成同步' });
          return;
        }
        if (existing.platform !== 'rainClassroom') {
          sendJson(res, 400, { ok: false, error: '当前护航接口仅支持雨课堂账号' });
          return;
        }
        if (!db.isDeviceBound(accountKey, deviceId)) {
          sendJson(res, 403, { ok: false, error: '当前设备未绑定该账号，无权上报护航' });
          return;
        }

        const body = await readJsonBody<ReportRcLessonGuardRequest>(req);
        const lessonId = String(body.lessonId ?? '').trim();
        if (!lessonId) {
          sendJson(res, 400, { ok: false, error: '缺少 lessonId' });
          return;
        }

        let courseId = String(body.courseId ?? '').trim();
        let classroomId = String(body.classroomId ?? '').trim();
        let courseTitle = String(body.courseTitle ?? '').trim();
        const classroom = String(body.classroom ?? '').trim();

        // 若扫码进班时客户端尚未拿到 courseId/classroomId，尝试从实时 on-lesson 补全
        if (!courseId || !classroomId) {
          try {
            const client = new RainClassroomClient(existing, (cookies) => {
              db.updateAccountCookies(existing.accountKey, cookies);
            });
            const onLessons = await client.getOnLesson();
            const hit = onLessons.find((i) => i.lessonId === lessonId);
            if (hit) {
              if (!courseId && hit.courseId) courseId = hit.courseId;
              if (!classroomId && hit.classroomId) classroomId = hit.classroomId;
              if (!courseTitle && hit.courseName) courseTitle = hit.courseName;
            }
          } catch (err) {
            logger.warn(
              'api',
              `上报护航单时反查 on-lesson 失败 (${accountKey}/${lessonId}): ${String(err)}`
            );
          }
        }

        let lastLocation: RcLessonGuardLocation | null = null;
        if (body.lastLocation && typeof body.lastLocation === 'object') {
          const lat = Number(body.lastLocation.latitude);
          const lng = Number(body.lastLocation.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            lastLocation = {
              address: String(body.lastLocation.address ?? ''),
              latitude: lat,
              longitude: lng,
            };
          }
        }

        const nowMs = Date.now();
        const semesterStart =
          existing.semesterStartMonday || config.semesterStartMonday;
        const computedExpireMs = computeClassSessionGuardExpiryUtc8({
          semesterStartMondayKey: semesterStart,
          timetable: existing.timetable,
          reservations: existing.reservations,
          courseId,
          classroomId,
          courseTitle,
          nowMs,
        });
        const requestedExpireMs =
          typeof body.expireAtMs === 'number' &&
          Number.isFinite(body.expireAtMs) &&
          body.expireAtMs > nowMs
            ? body.expireAtMs
            : 0;
        const expireAtMs = Math.max(computedExpireMs, requestedExpireMs);

        db.touchDeviceLastSeen(deviceId);
        const { guard, created } = db.upsertRcLessonGuard({
          accountKey,
          lessonId,
          courseId,
          classroomId,
          courseTitle: courseTitle || '雨课堂课程',
          classroom,
          lastLocation,
          expireAtMs,
          nowMs,
        });

        if (created) {
          const endParts = getUtc8Parts(guard.expireAtMs);
          const endHHMM = `${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')}`;
          db.addLog({
            accountKey: existing.accountKey,
            accountName: existing.name,
            platform: 'rainClassroom',
            category: 'session',
            level: 'info',
            title: `已开启本堂课防重开护航《${guard.courseTitle || '雨课堂课程'}》`,
            detail: `下课前（至 ${endHHMM}）若老师关闭并重开雨课堂将自动补签 · 账号 ${existing.name}`,
            courseName: guard.courseTitle || '雨课堂课程',
            lessonId,
          });
        }

        // 顺带挂载 WS（若配了 AI 同时自动答题；未配 AI 也监听课中定位与下课秒级重检）
        if (!rcAutoAnswer.isWatching(accountKey, lessonId)) {
          void rcAutoAnswer.attachLesson({
            account: existing,
            lessonId,
            courseId: guard.courseId,
            courseTitle: guard.courseTitle || '雨课堂课程',
            classroom: guard.classroom,
            watchOnly: !isAiReady(existing.aiConfig),
            guardLocationFallback: guard.lastLocation,
          });
        }

        scheduler.onWorkspaceUpdated();
        sendJson(res, 200, {
          ok: true,
          created,
          guard,
          serverTimeUtc8: formatUtc8Iso(),
        });
        return;
      }

      // 5. DELETE /api/v2/accounts/:accountKey/devices/:targetDeviceId - 解绑单台设备（退号或移除旧设备）
      const unbindMatch =
        /^\/api\/v2\/accounts\/([^/]+)\/devices\/([^/]+)$/.exec(pathname);
      if (req.method === 'DELETE' && unbindMatch) {
        const accountKey = decodeURIComponent(unbindMatch[1]).trim();
        const targetDeviceId = decodeURIComponent(unbindMatch[2]).trim();
        const existing = db.getAccount(accountKey);
        if (!existing) {
          sendJson(res, 200, {
            ok: true,
            unbound: false,
            remainingDevices: 0,
            accountStopped: false,
            detachedSessions: 0,
          });
          return;
        }
        if (!db.isDeviceBound(accountKey, deviceId)) {
          sendJson(res, 403, { ok: false, error: '当前设备未绑定该账号，无权解绑' });
          return;
        }

        const resUnbind = db.unbindDevice(accountKey, targetDeviceId);
        let detachedSessions = 0;
        if (resUnbind.accountRemoved) {
          detachedSessions = rcAutoAnswer.detachAccount(accountKey);
        }
        scheduler.onWorkspaceUpdated();

        sendJson(res, 200, {
          ok: true,
          unbound: resUnbind.unbound,
          remainingDevices: resUnbind.remainingDevices,
          accountStopped: resUnbind.accountRemoved,
          detachedSessions,
        });
        return;
      }

      // 6. DELETE /api/v2/accounts/:accountKey 或旧版 DELETE /api/accounts/:accountKey
      const delAccountMatch = /^\/api(?:\/v2)?\/accounts\/([^/]+)$/.exec(
        pathname
      );
      if (req.method === 'DELETE' && delAccountMatch) {
        const accountKey = decodeURIComponent(delAccountMatch[1]).trim();
        const force = url.searchParams.get('force') === 'true';
        const existing = db.getAccount(accountKey);
        if (!existing) {
          sendJson(res, 200, {
            ok: true,
            removed: false,
            remainingDevices: 0,
            accountStopped: false,
            detachedSessions: 0,
          });
          return;
        }
        if (!db.isDeviceBound(accountKey, deviceId)) {
          sendJson(res, 403, { ok: false, error: '当前设备未绑定该账号' });
          return;
        }

        if (force) {
          const detachedSessions = rcAutoAnswer.detachAccount(accountKey);
          const removed = db.forceRemoveAccount(accountKey);
          scheduler.onWorkspaceUpdated();
          sendJson(res, 200, {
            ok: true,
            removed,
            remainingDevices: 0,
            accountStopped: removed,
            detachedSessions,
          });
          return;
        }

        const resUnbind = db.unbindDevice(accountKey, deviceId);
        let detachedSessions = 0;
        if (resUnbind.accountRemoved) {
          detachedSessions = rcAutoAnswer.detachAccount(accountKey);
        }
        scheduler.onWorkspaceUpdated();
        sendJson(res, 200, {
          ok: true,
          removed: resUnbind.unbound,
          remainingDevices: resUnbind.remainingDevices,
          accountStopped: resUnbind.accountRemoved,
          detachedSessions,
        });
        return;
      }

      // 7. POST /api/sync - 兼容 v1.7.0 旧版客户端（安全防空覆盖 + 引用计数解绑）
      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readJsonBody<CloudSyncRequest>(req);
        if (!Array.isArray(body.accounts)) {
          sendJson(res, 400, { ok: false, error: 'accounts 必须为数组' });
          return;
        }

        const deviceMeta: DeviceMeta = {
          deviceId,
          deviceName: (body.deviceName ?? '').trim() || headerDeviceName,
          platformOs: body.platformOs ?? 'legacy',
          isTablet:
            typeof body.isTablet === 'boolean' ? body.isTablet : undefined,
        };

        const prevBoundKeys = new Set(db.getDeviceAccountKeys(deviceId));
        const incomingKeys = new Set<string>();
        let syncedCount = 0;
        let detachedSessions = 0;

        for (const item of body.accounts) {
          const accountKey = (item.accountKey ?? '').trim();
          const uid = String(item.uid ?? '').trim();
          if (!accountKey || !uid) continue;

          const server: RainClassroomServerType = item.server ?? 'yuketang';
          if (
            !isCanonicalAccountKeyMatch(accountKey, item.platform, server, uid)
          ) {
            continue;
          }
          const cookies = parseCookieInput(item.cookies);
          const existing = db.getAccount(accountKey);

          if (!existing) {
            const verifyNew = await ownershipVerifier({
              accountKey,
              platform: item.platform,
              server,
              uid,
              cookies,
              existingAccount: null,
            });
            if (!verifyNew.ok) continue;

            db.seedNewAccount({
              accountKey,
              platform: item.platform,
              server,
              uid,
              name: item.name,
              cookies,
              cookiesUpdatedAt: item.cookiesUpdatedAt,
              deviceInfo: item.deviceInfo,
              config: {
                semesterStartMonday: item.semesterStartMonday ?? null,
                timetable: Array.isArray(item.timetable) ? item.timetable : [],
                reservations: Array.isArray(item.reservations)
                  ? item.reservations
                  : [],
                courseLocations: item.courseLocations ?? {},
                aiConfig: item.aiConfig ?? null,
              },
              device: deviceMeta,
            });
            incomingKeys.add(accountKey);
            syncedCount++;
            continue;
          }

          if (
            existing.platform !== item.platform ||
            String(existing.uid) !== uid ||
            (existing.platform === 'rainClassroom' && existing.server !== server)
          ) {
            continue;
          }

          if (!db.isDeviceBound(accountKey, deviceId)) {
            const verify = await ownershipVerifier({
              accountKey,
              platform: existing.platform,
              server: existing.server,
              uid: existing.uid,
              cookies,
              existingAccount: existing,
            });
            if (!verify.ok) {
              continue;
            }
            db.bindOrTouchDevice(accountKey, deviceMeta);
          } else {
            db.bindOrTouchDevice(accountKey, deviceMeta);
          }

          incomingKeys.add(accountKey);
          syncedCount++;

          let verifiedLegacyCookies: Record<string, string> | undefined;
          let forceAcceptLegacyCookie = false;
          if (Object.keys(cookies).length > 0) {
            const sameToken = matchesStoredSessionToken(
              existing.platform,
              existing.uid,
              cookies,
              existing
            );
            if (!sameToken) {
              const verify = await ownershipVerifier({
                accountKey,
                platform: existing.platform,
                server: existing.server,
                uid: existing.uid,
                cookies,
                existingAccount: existing,
              });
              if (verify.ok) {
                verifiedLegacyCookies = cookies;
                forceAcceptLegacyCookie =
                  item.cookiesUpdatedAt === undefined ||
                  existing.sessionStatus !== 'ok';
              }
            }
          }

          const incomingEmpty = !hasNonEmptyConfig({
            timetable: item.timetable,
            reservations: item.reservations,
            courseLocations: item.courseLocations,
            aiConfig: item.aiConfig,
          });
          if (incomingEmpty && hasNonEmptyConfig(existing)) {
            if (verifiedLegacyCookies) {
              db.refreshAccountCookiesIfFresher({
                accountKey,
                cookies: verifiedLegacyCookies,
                cookiesUpdatedAt: item.cookiesUpdatedAt,
                deviceInfo: item.deviceInfo,
                name: item.name,
                forceAccept: forceAcceptLegacyCookie,
              });
            }
            continue;
          }

          const updated = db.updateAccountConfig({
            accountKey,
            platform: existing.platform,
            server: existing.server,
            uid: existing.uid,
            name: item.name,
            cookies: verifiedLegacyCookies,
            cookiesUpdatedAt: item.cookiesUpdatedAt,
            forceAcceptCookies: forceAcceptLegacyCookie,
            deviceInfo: item.deviceInfo,
            semesterStartMonday: item.semesterStartMonday,
            timetable: Array.isArray(item.timetable) ? item.timetable : [],
            reservations: Array.isArray(item.reservations) ? item.reservations : [],
            courseLocations: item.courseLocations,
            aiConfig: item.aiConfig,
            allowClearApiKey: false,
            device: deviceMeta,
          });
          if (!updated.aiConfig?.enabled) {
            detachedSessions += rcAutoAnswer.detachAccount(accountKey);
          }
        }

        const removedAccountKeys: string[] = [];
        for (const oldKey of prevBoundKeys) {
          if (!incomingKeys.has(oldKey)) {
            const resUnbind = db.unbindDevice(oldKey, deviceId);
            if (resUnbind.accountRemoved) {
              removedAccountKeys.push(oldKey);
              detachedSessions += rcAutoAnswer.detachAccount(oldKey);
            }
          }
        }

        scheduler.onWorkspaceUpdated();
        logger.info(
          'api',
          `兼容同步完成 device=${deviceId.slice(0, 8)}... accounts=${syncedCount} stopped=${removedAccountKeys.length}`
        );

        sendJson(res, 200, {
          ok: true,
          syncedCount,
          removedAccountKeys,
          detachedSessions,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
        });
        return;
      }

      // 8. GET /api/status - 拉取当前设备已绑定账号的状态、活跃托管会话、已签记录与日志
      if (req.method === 'GET' && pathname === '/api/status') {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80;
        db.touchDeviceLastSeen(deviceId);
        const boundAccounts = db.getAccountsForDevice(deviceId);
        const boundKeys = boundAccounts.map((a) => a.accountKey);

        sendJson(res, 200, {
          ok: true,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
          accounts: boundAccounts.map((a) =>
            buildAccountHealthSnapshot(db, a, deviceId)
          ),
          activeSessions: rcAutoAnswer.getSessionsForAccounts(boundKeys),
          activeGuards: db.getActiveRcLessonGuardsForAccounts(boundKeys),
          signedRecords: db.getSignedMapForAccounts(boundKeys),
          logs: db.getLogsForAccounts(boundKeys, limit),
        });
        return;
      }

      // 9. POST /api/sessions/:sessionKey/pause|resume - 远程暂停/恢复托管（任意已绑定设备均可操作）
      const sessionCtrlMatch =
        /^\/api\/sessions\/([^/]+)\/(pause|resume)$/.exec(pathname);
      if (req.method === 'POST' && sessionCtrlMatch) {
        const sessionKey = decodeURIComponent(sessionCtrlMatch[1]);
        const paused = sessionCtrlMatch[2] === 'pause';
        db.touchDeviceLastSeen(deviceId);
        const allowedKeys = db.getDeviceAccountKeys(deviceId);
        const updated = rcAutoAnswer.setSessionPaused(
          sessionKey,
          paused,
          allowedKeys
        );
        sendJson(res, updated ? 200 : 404, { ok: updated, paused });
        return;
      }

      // 10. POST /api/ai/test - 云端侧一键测试多模态 AI 连通性
      if (req.method === 'POST' && pathname === '/api/ai/test') {
        const aiConfig = await readJsonBody<AiConfig>(req);
        const result = await testVisionConnection(aiConfig);
        sendJson(res, 200, { ok: result.success, ...result });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE') {
        sendJson(res, 413, { ok: false, error: '请求体超出 2MB 限制' });
        return;
      }
      if (err instanceof URIError) {
        sendJson(res, 400, { ok: false, error: 'URL 参数编码非法' });
        return;
      }
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: 'JSON 格式解析失败' });
        return;
      }
      logger.error('api', `请求处理异常: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: '服务器内部异常' });
    }
  });
}

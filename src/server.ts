import http from 'node:http';
import { testVisionConnection } from './ai/vision_solver.js';
import type { AppConfig, Logger } from './config.js';
import { safeEqual } from './crypto.js';
import type { CloudDatabase } from './db.js';
import type { RcAutoAnswerEngine } from './engines/rc_auto_answer.js';
import type { CloudSchedulerEngine } from './engines/scheduler.js';
import { formatUtc8Iso } from './time.js';
import type { AiConfig, CloudSyncRequest } from './types.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB

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
      'Content-Type, X-Access-Code, X-User-Token, Authorization',
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
    if (total > MAX_BODY_BYTES) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export function createCloudServer(deps: {
  config: AppConfig;
  db: CloudDatabase;
  rcAutoAnswer: RcAutoAnswerEngine;
  scheduler: CloudSchedulerEngine;
  logger: Logger;
  startedAtMs?: number;
}): http.Server {
  const {
    config,
    db,
    rcAutoAnswer,
    scheduler,
    logger,
    startedAtMs = Date.now(),
  } = deps;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers':
            'Content-Type, X-Access-Code, X-User-Token, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      // 1. 公开存活探针 & 免费容器防休眠端点
      if (req.method === 'GET' && pathname === '/health') {
        const stats = db.getStats();
        sendJson(res, 200, {
          ok: true,
          service: 'course-helper-cloud',
          uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
          activeSessions: rcAutoAnswer.getActiveCount(),
          trackedWorkspaces: stats.workspaces,
          trackedAccounts: stats.accounts,
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

      const userToken = String(req.headers['x-user-token'] ?? '').trim();
      if (!userToken || userToken.length < 8 || userToken.length > 128) {
        sendJson(res, 400, {
          ok: false,
          error: '缺少或格式非法的个人同步码 (X-User-Token)',
        });
        return;
      }

      // 3. POST /api/sync - 原子同步本机全部账号、课表、预约与 AI 配置
      if (req.method === 'POST' && pathname === '/api/sync') {
        const body = await readJsonBody<CloudSyncRequest>(req);
        if (!Array.isArray(body.accounts)) {
          sendJson(res, 400, { ok: false, error: 'accounts 必须为数组' });
          return;
        }

        const { removedAccountKeys, syncedCount } = db.syncWorkspaceAccounts(
          userToken,
          body.accounts
        );

        let detachedSessions = 0;
        for (const removedKey of removedAccountKeys) {
          detachedSessions += rcAutoAnswer.detachAccount(userToken, removedKey);
        }

        // 若某账号在同步中关闭了 AI，也立即停掉该账号的 WS
        for (const acc of body.accounts) {
          if (!acc.aiConfig?.enabled) {
            detachedSessions += rcAutoAnswer.detachAccount(
              userToken,
              acc.accountKey
            );
          }
        }

        scheduler.onWorkspaceUpdated();
        logger.info(
          'api',
          `工作空间同步完成 token=${userToken.slice(0, 8)}... accounts=${syncedCount} removed=${removedAccountKeys.length}`
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

      // 4. DELETE /api/accounts/:accountKey - 退号立即停服并清理
      const delMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname);
      if (req.method === 'DELETE' && delMatch) {
        const accountKey = decodeURIComponent(delMatch[1]);
        const detached = rcAutoAnswer.detachAccount(userToken, accountKey);
        const removed = db.removeAccount(userToken, accountKey);
        scheduler.onWorkspaceUpdated();
        sendJson(res, 200, { ok: true, removed, detachedSessions: detached });
        return;
      }

      // 5. GET /api/status - 拉取工作空间状态、活跃托管会话、已签记录与日志
      if (req.method === 'GET' && pathname === '/api/status') {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '80', 10) || 80;
        const accounts = db.getWorkspaceAccounts(userToken).map((a) => ({
          accountKey: a.accountKey,
          platform: a.platform,
          server: a.server,
          uid: a.uid,
          name: a.name,
          sessionStatus: a.sessionStatus,
          sessionError: a.sessionError,
          reservationCount: a.reservations.filter((r) => r.enabled).length,
          timetableCount: a.timetable.length,
          aiEnabled: Boolean(a.aiConfig?.enabled),
          updatedAt: a.updatedAt,
        }));

        sendJson(res, 200, {
          ok: true,
          semesterStartMonday: config.semesterStartMonday,
          serverTimeUtc8: formatUtc8Iso(),
          accounts,
          activeSessions: rcAutoAnswer.getWorkspaceSessions(userToken),
          signedRecords: db.getWorkspaceSignedMap(userToken),
          logs: db.getWorkspaceLogs(userToken, limit),
        });
        return;
      }

      // 6. POST /api/sessions/:sessionKey/pause|resume - 远程暂停/恢复托管
      const sessionCtrlMatch =
        /^\/api\/sessions\/([^/]+)\/(pause|resume)$/.exec(pathname);
      if (req.method === 'POST' && sessionCtrlMatch) {
        const sessionKey = decodeURIComponent(sessionCtrlMatch[1]);
        const paused = sessionCtrlMatch[2] === 'pause';
        const updated = rcAutoAnswer.setSessionPaused(
          userToken,
          sessionKey,
          paused
        );
        sendJson(res, updated ? 200 : 404, { ok: updated, paused });
        return;
      }

      // 7. POST /api/ai/test - 云端侧一键测试多模态 AI 连通性
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
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { ok: false, error: 'JSON 格式解析失败' });
        return;
      }
      logger.error('api', `请求处理异常: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: '服务器内部异常' });
    }
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from './crypto.js';
import { formatUtc8Iso } from './time.js';
import type {
  AccountDeviceInfo,
  AccountSessionStatus,
  AccountSyncItem,
  AiConfig,
  CourseLocationPreset,
  ExecutionLogItem,
  LogCategory,
  LogSeverity,
  PlatformType,
  RainClassroomServerType,
  SignReservation,
  StoredAccount,
  TimetableCourse,
} from './types.js';

export function parseCookieInput(
  raw: Record<string, string> | string | undefined
): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const out: Record<string, string> = {};
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (key && v !== undefined && v !== null) {
      out[key] = String(v).trim();
    }
  }
  return out;
}

export class CloudDatabase {
  private readonly db: DatabaseSync;
  private readonly secretBox: SecretBox;
  private readonly maxLogsPerWorkspace: number;

  constructor(options: {
    dataDir: string;
    encryptionKey: string;
    maxLogsPerWorkspace?: number;
    dbFileName?: string;
  }) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    const dbPath = path.join(options.dataDir, options.dbFileName ?? 'cloud.db');
    this.db = new DatabaseSync(dbPath);
    this.secretBox = new SecretBox(options.encryptionKey);
    this.maxLogsPerWorkspace = options.maxLogsPerWorkspace ?? 300;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS workspaces (
        user_token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_sync_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        user_token TEXT NOT NULL,
        account_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        server TEXT NOT NULL,
        uid TEXT NOT NULL,
        name TEXT NOT NULL,
        cookies_enc TEXT NOT NULL,
        device_info_enc TEXT NOT NULL,
        semester_start_monday TEXT,
        timetable_json TEXT NOT NULL,
        reservations_json TEXT NOT NULL,
        course_locations_json TEXT NOT NULL,
        ai_config_enc TEXT NOT NULL,
        session_status TEXT NOT NULL DEFAULT 'ok',
        session_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_token, account_key),
        FOREIGN KEY (user_token) REFERENCES workspaces(user_token) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS signed_records (
        user_token TEXT NOT NULL,
        account_key TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        signed_at TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_token, account_key, reservation_id, date_key)
      );

      CREATE TABLE IF NOT EXISTS answered_problems (
        user_token TEXT NOT NULL,
        account_key TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        PRIMARY KEY (user_token, account_key, lesson_id, problem_id)
      );

      CREATE TABLE IF NOT EXISTS execution_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_token TEXT NOT NULL,
        account_key TEXT NOT NULL,
        account_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        course_name TEXT NOT NULL DEFAULT '',
        lesson_id TEXT NOT NULL DEFAULT '',
        problem_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_logs_workspace_id
        ON execution_logs (user_token, id DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 原子同步某个设备/工作空间的全部账号列表。
   * 返回被移除的 accountKey 列表（供上层立即断开对应 WS 会话）。
   */
  syncWorkspaceAccounts(
    userToken: string,
    incomingAccounts: AccountSyncItem[]
  ): { removedAccountKeys: string[]; syncedCount: number } {
    const now = formatUtc8Iso();
    const existingRows = this.db
      .prepare('SELECT account_key FROM accounts WHERE user_token = ?')
      .all(userToken) as Array<{ account_key: string }>;
    const existingKeys = new Set(existingRows.map((r) => r.account_key));
    const incomingKeys = new Set<string>();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO workspaces (user_token, created_at, last_sync_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_token) DO UPDATE SET last_sync_at = excluded.last_sync_at`
        )
        .run(userToken, now, now);

      const upsertStmt = this.db.prepare(`
        INSERT INTO accounts (
          user_token, account_key, platform, server, uid, name,
          cookies_enc, device_info_enc, semester_start_monday,
          timetable_json, reservations_json, course_locations_json,
          ai_config_enc, session_status, session_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', '', ?)
        ON CONFLICT(user_token, account_key) DO UPDATE SET
          platform = excluded.platform,
          server = excluded.server,
          uid = excluded.uid,
          name = excluded.name,
          cookies_enc = excluded.cookies_enc,
          device_info_enc = excluded.device_info_enc,
          semester_start_monday = excluded.semester_start_monday,
          timetable_json = excluded.timetable_json,
          reservations_json = excluded.reservations_json,
          course_locations_json = excluded.course_locations_json,
          ai_config_enc = excluded.ai_config_enc,
          session_status = 'ok',
          session_error = '',
          updated_at = excluded.updated_at
      `);

      const upsertSignedStmt = this.db.prepare(`
        INSERT OR IGNORE INTO signed_records (
          user_token, account_key, reservation_id, date_key, signed_at, detail
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const item of incomingAccounts) {
        const accountKey = (item.accountKey ?? '').trim();
        if (!accountKey || !item.uid) continue;
        incomingKeys.add(accountKey);

        const cookiesMap = parseCookieInput(item.cookies);
        const server: RainClassroomServerType = item.server ?? 'yuketang';
        const deviceInfo = item.deviceInfo ?? {};
        const reservations = Array.isArray(item.reservations)
          ? item.reservations
          : [];
        const timetable = Array.isArray(item.timetable) ? item.timetable : [];
        const courseLocations = item.courseLocations ?? {};
        const aiConfig = item.aiConfig ?? null;

        upsertStmt.run(
          userToken,
          accountKey,
          item.platform,
          server,
          String(item.uid),
          (item.name ?? '').trim() || String(item.uid),
          this.secretBox.encrypt(JSON.stringify(cookiesMap)),
          this.secretBox.encrypt(JSON.stringify(deviceInfo)),
          item.semesterStartMonday ?? null,
          JSON.stringify(timetable),
          JSON.stringify(reservations),
          JSON.stringify(courseLocations),
          aiConfig ? this.secretBox.encrypt(JSON.stringify(aiConfig)) : '',
          now
        );

        // 同步客户端已有的历史已签日期，避免重复签到
        for (const res of reservations) {
          if (res.signedDates && typeof res.signedDates === 'object') {
            for (const [dateKey, signedAt] of Object.entries(res.signedDates)) {
              if (dateKey) {
                upsertSignedStmt.run(
                  userToken,
                  accountKey,
                  res.id,
                  dateKey,
                  String(signedAt || now),
                  '客户端同步'
                );
              }
            }
          }
        }
      }

      const removedAccountKeys: string[] = [];
      for (const oldKey of existingKeys) {
        if (!incomingKeys.has(oldKey)) {
          removedAccountKeys.push(oldKey);
          this.deleteAccountInternal(userToken, oldKey);
        }
      }

      this.db.exec('COMMIT');
      return { removedAccountKeys, syncedCount: incomingKeys.size };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  removeAccount(userToken: string, accountKey: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.deleteAccountInternal(userToken, accountKey);
      this.db.exec('COMMIT');
      return removed;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private deleteAccountInternal(userToken: string, accountKey: string): boolean {
    const info = this.db
      .prepare('DELETE FROM accounts WHERE user_token = ? AND account_key = ?')
      .run(userToken, accountKey);
    this.db
      .prepare(
        'DELETE FROM signed_records WHERE user_token = ? AND account_key = ?'
      )
      .run(userToken, accountKey);
    this.db
      .prepare(
        'DELETE FROM answered_problems WHERE user_token = ? AND account_key = ?'
      )
      .run(userToken, accountKey);
    return Number(info.changes) > 0;
  }

  updateAccountCookies(
    userToken: string,
    accountKey: string,
    cookies: Record<string, string>
  ): void {
    const enc = this.secretBox.encrypt(JSON.stringify(cookies));
    this.db
      .prepare(
        `UPDATE accounts SET cookies_enc = ?, updated_at = ?
         WHERE user_token = ? AND account_key = ?`
      )
      .run(enc, formatUtc8Iso(), userToken, accountKey);
  }

  setAccountSessionStatus(
    userToken: string,
    accountKey: string,
    status: AccountSessionStatus,
    error = ''
  ): void {
    this.db
      .prepare(
        `UPDATE accounts SET session_status = ?, session_error = ?, updated_at = ?
         WHERE user_token = ? AND account_key = ?`
      )
      .run(status, error, formatUtc8Iso(), userToken, accountKey);
  }

  getAllAccounts(): StoredAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeAccount(row));
  }

  getWorkspaceAccounts(userToken: string): StoredAccount[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM accounts WHERE user_token = ? ORDER BY updated_at DESC'
      )
      .all(userToken) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeAccount(row));
  }

  getAccount(userToken: string, accountKey: string): StoredAccount | null {
    const row = this.db
      .prepare(
        'SELECT * FROM accounts WHERE user_token = ? AND account_key = ?'
      )
      .get(userToken, accountKey) as Record<string, unknown> | undefined;
    return row ? this.deserializeAccount(row) : null;
  }

  private deserializeAccount(row: Record<string, unknown>): StoredAccount {
    const safeParse = <T>(raw: string, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    const cookiesRaw = this.secretBox.decrypt(String(row.cookies_enc ?? ''));
    const deviceRaw = this.secretBox.decrypt(String(row.device_info_enc ?? ''));
    const aiRaw = row.ai_config_enc
      ? this.secretBox.decrypt(String(row.ai_config_enc))
      : '';

    return {
      userToken: String(row.user_token),
      accountKey: String(row.account_key),
      platform:
        row.platform === 'chaoxing' ? 'chaoxing' : ('rainClassroom' as PlatformType),
      server: (row.server as RainClassroomServerType) || 'yuketang',
      uid: String(row.uid),
      name: String(row.name),
      cookies: safeParse<Record<string, string>>(cookiesRaw, {}),
      deviceInfo: safeParse<AccountDeviceInfo>(deviceRaw, {}),
      semesterStartMonday:
        typeof row.semester_start_monday === 'string' &&
        row.semester_start_monday.trim()
          ? row.semester_start_monday.trim()
          : null,
      timetable: safeParse<TimetableCourse[]>(
        String(row.timetable_json ?? '[]'),
        []
      ),
      reservations: safeParse<SignReservation[]>(
        String(row.reservations_json ?? '[]'),
        []
      ),
      courseLocations: safeParse<Record<string, CourseLocationPreset>>(
        String(row.course_locations_json ?? '{}'),
        {}
      ),
      aiConfig: aiRaw ? safeParse<AiConfig | null>(aiRaw, null) : null,
      sessionStatus: (row.session_status as AccountSessionStatus) || 'ok',
      sessionError: String(row.session_error ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  isReservationSigned(
    userToken: string,
    accountKey: string,
    reservationId: string,
    dateKey: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM signed_records
         WHERE user_token = ? AND account_key = ? AND reservation_id = ? AND date_key = ?`
      )
      .get(userToken, accountKey, reservationId, dateKey);
    return Boolean(row);
  }

  markReservationSigned(
    userToken: string,
    accountKey: string,
    reservationId: string,
    dateKey: string,
    detail = ''
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signed_records (
          user_token, account_key, reservation_id, date_key, signed_at, detail
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(userToken, accountKey, reservationId, dateKey, formatUtc8Iso(), detail);
  }

  getWorkspaceSignedMap(
    userToken: string
  ): Record<string, Record<string, Record<string, string>>> {
    const rows = this.db
      .prepare(
        `SELECT account_key, reservation_id, date_key, signed_at
         FROM signed_records WHERE user_token = ?`
      )
      .all(userToken) as Array<{
      account_key: string;
      reservation_id: string;
      date_key: string;
      signed_at: string;
    }>;

    // accountKey -> reservationId -> dateKey -> signedAt
    const out: Record<string, Record<string, Record<string, string>>> = {};
    for (const r of rows) {
      out[r.account_key] ??= {};
      out[r.account_key][r.reservation_id] ??= {};
      out[r.account_key][r.reservation_id][r.date_key] = r.signed_at;
    }
    return out;
  }

  isProblemAnswered(
    userToken: string,
    accountKey: string,
    lessonId: string,
    problemId: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM answered_problems
         WHERE user_token = ? AND account_key = ? AND lesson_id = ? AND problem_id = ?`
      )
      .get(userToken, accountKey, lessonId, problemId);
    return Boolean(row);
  }

  markProblemAnswered(
    userToken: string,
    accountKey: string,
    lessonId: string,
    problemId: string
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO answered_problems (
          user_token, account_key, lesson_id, problem_id, answered_at
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(userToken, accountKey, lessonId, problemId, formatUtc8Iso());
  }

  addLog(entry: {
    userToken: string;
    accountKey: string;
    accountName: string;
    platform: PlatformType | 'system';
    category: LogCategory;
    level: LogSeverity;
    title: string;
    detail: string;
    courseName?: string;
    lessonId?: string;
    problemId?: string;
  }): ExecutionLogItem {
    const createdAt = formatUtc8Iso();
    const res = this.db
      .prepare(
        `INSERT INTO execution_logs (
          user_token, account_key, account_name, platform, category,
          level, title, detail, course_name, lesson_id, problem_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.userToken,
        entry.accountKey,
        entry.accountName,
        entry.platform,
        entry.category,
        entry.level,
        entry.title,
        entry.detail,
        entry.courseName ?? '',
        entry.lessonId ?? '',
        entry.problemId ?? '',
        createdAt
      );

    // 保留最近 N 条日志，防止免费容器 SQLite 膨胀
    this.db
      .prepare(
        `DELETE FROM execution_logs
         WHERE user_token = ?
           AND id NOT IN (
             SELECT id FROM execution_logs
             WHERE user_token = ?
             ORDER BY id DESC
             LIMIT ?
           )`
      )
      .run(entry.userToken, entry.userToken, this.maxLogsPerWorkspace);

    return {
      id: Number(res.lastInsertRowid),
      userToken: entry.userToken,
      accountKey: entry.accountKey,
      accountName: entry.accountName,
      platform: entry.platform,
      category: entry.category,
      level: entry.level,
      title: entry.title,
      detail: entry.detail,
      courseName: entry.courseName ?? '',
      lessonId: entry.lessonId ?? '',
      problemId: entry.problemId ?? '',
      createdAt,
    };
  }

  getWorkspaceLogs(userToken: string, limit = 80): ExecutionLogItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_logs
         WHERE user_token = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(userToken, Math.max(1, Math.min(300, limit))) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: Number(r.id),
      userToken: String(r.user_token),
      accountKey: String(r.account_key),
      accountName: String(r.account_name),
      platform: String(r.platform) as PlatformType | 'system',
      category: String(r.category) as LogCategory,
      level: String(r.level) as LogSeverity,
      title: String(r.title),
      detail: String(r.detail),
      courseName: String(r.course_name ?? ''),
      lessonId: String(r.lesson_id ?? ''),
      problemId: String(r.problem_id ?? ''),
      createdAt: String(r.created_at),
    }));
  }

  getStats(): { workspaces: number; accounts: number } {
    const w = this.db
      .prepare('SELECT COUNT(*) AS c FROM workspaces')
      .get() as { c: number };
    const a = this.db
      .prepare('SELECT COUNT(*) AS c FROM accounts')
      .get() as { c: number };
    return { workspaces: Number(w?.c ?? 0), accounts: Number(a?.c ?? 0) };
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecretBox } from './crypto.js';
import { formatUtc8Iso } from './time.js';
import type {
  AccountConfigPayload,
  AccountDeviceInfo,
  AccountSessionStatus,
  AiConfig,
  BoundDeviceInfo,
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

export interface DbOptions {
  dataDir: string;
  encryptionKey: string;
  maxLogsPerWorkspace?: number;
}

export interface DeviceMeta {
  deviceId: string;
  deviceName?: string;
  platformOs?: string;
  isTablet?: boolean;
}

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
    if (!key) continue;
    out[key] = String(v ?? '').trim();
  }
  return out;
}

export function hasNonEmptyConfig(cfg: {
  timetable?: TimetableCourse[];
  reservations?: SignReservation[];
  courseLocations?: Record<string, CourseLocationPreset>;
  aiConfig?: AiConfig | null;
}): boolean {
  if (Array.isArray(cfg.timetable) && cfg.timetable.length > 0) return true;
  if (Array.isArray(cfg.reservations) && cfg.reservations.length > 0) return true;
  if (cfg.courseLocations && Object.keys(cfg.courseLocations).length > 0) {
    return true;
  }
  if (cfg.aiConfig?.enabled) return true;
  if (cfg.aiConfig?.apiKey && cfg.aiConfig.apiKey.trim().length > 0) return true;
  return false;
}

export function mergeAiConfigSafe(
  incoming: AiConfig | null | undefined,
  existing: AiConfig | null,
  allowClearApiKey = false
): AiConfig | null {
  if (!incoming) return existing;
  const incomingKey = (incoming.apiKey ?? '').trim();
  const existingKey = (existing?.apiKey ?? '').trim();
  if (!allowClearApiKey && !incomingKey && existing && existingKey) {
    return {
      ...incoming,
      providerId: incoming.providerId?.trim() || existing.providerId,
      baseUrl: incoming.baseUrl?.trim() || existing.baseUrl,
      apiKey: existing.apiKey,
      model: incoming.model?.trim() || existing.model,
    };
  }
  return incoming;
}

export class CloudDatabase {
  private readonly db: DatabaseSync;
  private readonly secretBox: SecretBox;
  private readonly maxLogsPerAccount: number;
  private readonly maxDevicesPerAccount = 10;

  constructor(options: DbOptions) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    const dbPath = path.join(options.dataDir, 'cloud.db');
    this.db = new DatabaseSync(dbPath);
    this.secretBox = new SecretBox(options.encryptionKey);
    this.maxLogsPerAccount = options.maxLogsPerWorkspace ?? 200;
    this.migrate();
  }

  private createV2Schema(prefix = ''): void {
    const tAccounts = `accounts${prefix}`;
    const tDevices = `account_devices${prefix}`;
    const tSigned = `signed_records${prefix}`;
    const tAnswered = `answered_problems${prefix}`;
    const tLogs = `execution_logs${prefix}`;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tAccounts} (
        account_key TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        server TEXT NOT NULL,
        uid TEXT NOT NULL,
        name TEXT NOT NULL,
        cookies_enc TEXT NOT NULL,
        cookies_updated_at INTEGER NOT NULL DEFAULT 0,
        device_info_enc TEXT NOT NULL,
        semester_start_monday TEXT,
        timetable_json TEXT NOT NULL,
        reservations_json TEXT NOT NULL,
        course_locations_json TEXT NOT NULL,
        ai_config_enc TEXT NOT NULL,
        config_rev INTEGER NOT NULL DEFAULT 1,
        config_updated_at TEXT NOT NULL,
        last_editor_device_id TEXT NOT NULL DEFAULT '',
        session_status TEXT NOT NULL DEFAULT 'ok',
        session_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${tDevices} (
        account_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL DEFAULT '',
        platform_os TEXT NOT NULL DEFAULT '',
        is_tablet INTEGER NOT NULL DEFAULT 0,
        bound_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        PRIMARY KEY (account_key, device_id),
        FOREIGN KEY (account_key) REFERENCES ${tAccounts}(account_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS ${tSigned} (
        account_key TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        signed_at TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (account_key, reservation_id, date_key)
      );

      CREATE TABLE IF NOT EXISTS ${tAnswered} (
        account_key TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        PRIMARY KEY (account_key, lesson_id, problem_id)
      );

      CREATE TABLE IF NOT EXISTS ${tLogs} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    `);
  }

  private createIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_account_id
        ON execution_logs (account_key, id DESC);
      CREATE INDEX IF NOT EXISTS idx_devices_device_id
        ON account_devices (device_id, account_key);
      CREATE INDEX IF NOT EXISTS idx_devices_last_seen
        ON account_devices (last_seen_ms);
    `);
  }

  private safeRollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors when no transaction is active
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }

  private clampCookieTimestamp(
    incTs: number | undefined,
    existingTs: number,
    forceAccept: boolean,
    nowMs: number
  ): number {
    const maxAllowed = nowMs + 5 * 60 * 1000;
    const base =
      incTs && incTs > 0 ? Math.min(incTs, maxAllowed) : nowMs;
    if (forceAccept && base <= existingTs) {
      return existingTs + 1;
    }
    return base;
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);

    const cols = this.db
      .prepare('PRAGMA table_info(accounts)')
      .all() as Array<{ name: string }>;

    const isLegacyV1 = cols.some((c) => c.name === 'user_token');
    if (isLegacyV1) {
      this.migrateFromV1ToV2();
      return;
    }

    this.createV2Schema('');
    this.createIndexes();
  }

  private migrateFromV1ToV2(): void {
    const nowIso = formatUtc8Iso();
    const nowMs = Date.now();

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS execution_logs_v2;
        DROP TABLE IF EXISTS answered_problems_v2;
        DROP TABLE IF EXISTS signed_records_v2;
        DROP TABLE IF EXISTS account_devices_v2;
        DROP TABLE IF EXISTS accounts_v2;
      `);
      this.createV2Schema('_v2');

      const oldAccounts = this.db
        .prepare('SELECT * FROM accounts ORDER BY updated_at DESC')
        .all() as Array<Record<string, unknown>>;

      const bestByAccount = new Map<string, Record<string, unknown>>();
      const newestOkCookiesByAccount = new Map<
        string,
        { cookiesEnc: string; deviceInfoEnc: string; updatedAt: string }
      >();
      const devicesToInsert: Array<{
        accountKey: string;
        deviceId: string;
        updatedAt: string;
      }> = [];

      const scoreRow = (r: Record<string, unknown>): number => {
        let s = 0;
        if (String(r.timetable_json ?? '[]').length > 4) s += 4;
        if (String(r.reservations_json ?? '[]').length > 4) s += 4;
        if (String(r.course_locations_json ?? '{}').length > 4) s += 2;
        if (String(r.ai_config_enc ?? '').length > 0) s += 2;
        if (String(r.session_status ?? '') === 'ok') s += 1;
        return s;
      };

      for (const row of oldAccounts) {
        const accountKey = String(row.account_key ?? '').trim();
        const userToken = String(row.user_token ?? '').trim();
        if (!accountKey || !userToken) continue;

        const updatedAt = String(row.updated_at ?? nowIso);
        devicesToInsert.push({
          accountKey,
          deviceId: userToken,
          updatedAt,
        });

        if (
          String(row.session_status ?? 'ok') === 'ok' &&
          !newestOkCookiesByAccount.has(accountKey)
        ) {
          newestOkCookiesByAccount.set(accountKey, {
            cookiesEnc: String(row.cookies_enc ?? ''),
            deviceInfoEnc: String(row.device_info_enc ?? ''),
            updatedAt,
          });
        }

        const prev = bestByAccount.get(accountKey);
        if (!prev || scoreRow(row) > scoreRow(prev)) {
          bestByAccount.set(accountKey, row);
        }
      }

      const insAcc = this.db.prepare(`
        INSERT INTO accounts_v2 (
          account_key, platform, server, uid, name,
          cookies_enc, cookies_updated_at, device_info_enc,
          semester_start_monday, timetable_json, reservations_json,
          course_locations_json, ai_config_enc,
          config_rev, config_updated_at, last_editor_device_id,
          session_status, session_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `);

      for (const row of bestByAccount.values()) {
        const accountKey = String(row.account_key);
        const updatedAt = String(row.updated_at ?? nowIso);
        const freshestCookie = newestOkCookiesByAccount.get(accountKey);
        const parsedCookieMs = freshestCookie
          ? Date.parse(freshestCookie.updatedAt)
          : Date.parse(updatedAt);
        const cookieTs =
          Number.isFinite(parsedCookieMs) && parsedCookieMs > 0
            ? parsedCookieMs
            : nowMs;

        insAcc.run(
          accountKey,
          String(row.platform ?? 'rainClassroom'),
          String(row.server ?? 'yuketang'),
          String(row.uid ?? ''),
          String(row.name ?? ''),
          freshestCookie?.cookiesEnc ?? String(row.cookies_enc ?? ''),
          cookieTs,
          freshestCookie?.deviceInfoEnc ?? String(row.device_info_enc ?? ''),
          typeof row.semester_start_monday === 'string'
            ? row.semester_start_monday
            : null,
          String(row.timetable_json ?? '[]'),
          String(row.reservations_json ?? '[]'),
          String(row.course_locations_json ?? '{}'),
          String(row.ai_config_enc ?? ''),
          updatedAt,
          String(row.user_token ?? ''),
          freshestCookie ? 'ok' : String(row.session_status ?? 'ok'),
          freshestCookie ? '' : String(row.session_error ?? ''),
          updatedAt
        );
      }

      const insDev = this.db.prepare(`
        INSERT OR IGNORE INTO account_devices_v2 (
          account_key, device_id, device_name, platform_os, is_tablet,
          bound_at, last_seen_at, last_seen_ms
        ) VALUES (?, ?, '已迁移设备', 'legacy', 0, ?, ?, ?)
      `);
      for (const d of devicesToInsert) {
        if (!bestByAccount.has(d.accountKey)) continue;
        const parsedSeen = Date.parse(d.updatedAt);
        const seenMs =
          Number.isFinite(parsedSeen) && parsedSeen > 0 ? parsedSeen : nowMs;
        insDev.run(d.accountKey, d.deviceId, d.updatedAt, d.updatedAt, seenMs);
      }

      if (this.tableExists('signed_records')) {
        this.db.exec(`
          INSERT OR IGNORE INTO signed_records_v2 (
            account_key, reservation_id, date_key, signed_at, detail
          )
          SELECT account_key, reservation_id, date_key, signed_at, detail
          FROM signed_records;
        `);
      }
      if (this.tableExists('answered_problems')) {
        this.db.exec(`
          INSERT OR IGNORE INTO answered_problems_v2 (
            account_key, lesson_id, problem_id, answered_at
          )
          SELECT account_key, lesson_id, problem_id, answered_at
          FROM answered_problems;
        `);
      }
      if (this.tableExists('execution_logs')) {
        this.db.exec(`
          INSERT INTO execution_logs_v2 (
            account_key, account_name, platform, category, level,
            title, detail, course_name, lesson_id, problem_id, created_at
          )
          SELECT account_key, account_name, platform, category, level,
            title, detail, course_name, lesson_id, problem_id, created_at
          FROM execution_logs
          ORDER BY id ASC;
        `);
      }

      this.db.exec(`
        DROP TABLE IF EXISTS execution_logs;
        DROP TABLE IF EXISTS answered_problems;
        DROP TABLE IF EXISTS signed_records;
        DROP TABLE IF EXISTS accounts;
        DROP TABLE IF EXISTS workspaces;

        ALTER TABLE accounts_v2 RENAME TO accounts;
        ALTER TABLE account_devices_v2 RENAME TO account_devices;
        ALTER TABLE signed_records_v2 RENAME TO signed_records;
        ALTER TABLE answered_problems_v2 RENAME TO answered_problems;
        ALTER TABLE execution_logs_v2 RENAME TO execution_logs;
      `);

      this.createIndexes();
      this.db.exec('COMMIT');
    } catch (err) {
      this.safeRollback();
      throw err;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  close(): void {
    this.db.close();
  }

  private normalizeDeviceName(meta: DeviceMeta): string {
    const raw = (meta.deviceName ?? '').trim();
    if (raw) return raw.slice(0, 64);
    const shortId = meta.deviceId.slice(-4);
    if (meta.platformOs === 'ios') {
      return meta.isTablet ? `iPad · ${shortId}` : `iPhone · ${shortId}`;
    }
    if (meta.platformOs === 'android') {
      return meta.isTablet ? `Android 平板 · ${shortId}` : `Android 手机 · ${shortId}`;
    }
    if (meta.platformOs === 'legacy') {
      return `旧版设备 · ${shortId}`;
    }
    return `设备 · ${shortId}`;
  }

  private bindOrTouchDeviceInternal(
    accountKey: string,
    meta: DeviceMeta,
    nowIso: string,
    nowMs: number
  ): void {
    const rawName = (meta.deviceName ?? '').trim().slice(0, 64);
    const insertName = this.normalizeDeviceName(meta);
    const platformOs = (meta.platformOs ?? '').trim().slice(0, 24) || 'unknown';
    const insertIsTablet = meta.isTablet ? 1 : 0;
    const updateIsTablet: number | null =
      typeof meta.isTablet === 'boolean' ? (meta.isTablet ? 1 : 0) : null;

    this.db
      .prepare(
        `INSERT INTO account_devices (
          account_key, device_id, device_name, platform_os, is_tablet,
          bound_at, last_seen_at, last_seen_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key, device_id) DO UPDATE SET
          device_name = CASE WHEN ? != '' THEN ? ELSE account_devices.device_name END,
          platform_os = CASE WHEN excluded.platform_os != 'unknown' THEN excluded.platform_os ELSE account_devices.platform_os END,
          is_tablet = COALESCE(?, account_devices.is_tablet),
          last_seen_at = excluded.last_seen_at,
          last_seen_ms = excluded.last_seen_ms`
      )
      .run(
        accountKey,
        meta.deviceId,
        insertName,
        platformOs,
        insertIsTablet,
        nowIso,
        nowIso,
        nowMs,
        rawName,
        rawName,
        updateIsTablet
      );

    // 单账号最多保留最近活跃的 N 台设备，防止异常重装堆积
    const countRow = this.db
      .prepare('SELECT COUNT(*) AS c FROM account_devices WHERE account_key = ?')
      .get(accountKey) as { c: number };
    if (Number(countRow?.c ?? 0) > this.maxDevicesPerAccount) {
      this.db
        .prepare(
          `DELETE FROM account_devices
           WHERE account_key = ?
             AND device_id != ?
             AND device_id NOT IN (
               SELECT device_id FROM account_devices
               WHERE account_key = ?
               ORDER BY last_seen_ms DESC
               LIMIT ?
             )`
        )
        .run(
          accountKey,
          meta.deviceId,
          accountKey,
          this.maxDevicesPerAccount
        );
    }
  }

  bindOrTouchDevice(accountKey: string, meta: DeviceMeta, nowMs = Date.now()): void {
    this.bindOrTouchDeviceInternal(accountKey, meta, formatUtc8Iso(nowMs), nowMs);
  }

  touchDeviceLastSeen(deviceId: string, nowMs = Date.now()): void {
    const cleanId = deviceId.trim();
    if (!cleanId) return;
    this.db
      .prepare(
        'UPDATE account_devices SET last_seen_at = ?, last_seen_ms = ? WHERE device_id = ?'
      )
      .run(formatUtc8Iso(nowMs), nowMs, cleanId);
  }

  isDeviceBound(accountKey: string, deviceId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM account_devices WHERE account_key = ? AND device_id = ?'
      )
      .get(accountKey, deviceId);
    return Boolean(row);
  }

  getBoundDevices(accountKey: string, currentDeviceId?: string): BoundDeviceInfo[] {
    const rows = this.db
      .prepare(
        `SELECT device_id, device_name, platform_os, is_tablet, bound_at, last_seen_at, last_seen_ms
         FROM account_devices
         WHERE account_key = ?
         ORDER BY last_seen_ms DESC`
      )
      .all(accountKey) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const id = String(r.device_id);
      return {
        deviceId: id,
        deviceName: String(r.device_name ?? ''),
        platformOs: String(r.platform_os ?? ''),
        isTablet: Number(r.is_tablet ?? 0) === 1,
        boundAt: String(r.bound_at ?? ''),
        lastSeenAt: String(r.last_seen_at ?? ''),
        lastSeenMs: Number(r.last_seen_ms ?? 0),
        isCurrentDevice: currentDeviceId ? id === currentDeviceId : undefined,
      };
    });
  }

  /**
   * 选举主兜底设备：优先非平板（手机端）中最近活跃的设备，避免双机同时本地兜底撞车。
   */
  selectPrimaryDeviceId(accountKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT device_id FROM account_devices
         WHERE account_key = ?
         ORDER BY is_tablet ASC, last_seen_ms DESC
         LIMIT 1`
      )
      .get(accountKey) as { device_id?: string } | undefined;
    return row?.device_id ?? null;
  }

  getDeviceAccountKeys(deviceId: string): string[] {
    const rows = this.db
      .prepare('SELECT account_key FROM account_devices WHERE device_id = ?')
      .all(deviceId) as Array<{ account_key: string }>;
    return rows.map((r) => r.account_key);
  }

  getAccountsForDevice(deviceId: string): StoredAccount[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM accounts a
         INNER JOIN account_devices d ON a.account_key = d.account_key
         WHERE d.device_id = ?
         ORDER BY a.updated_at DESC`
      )
      .all(deviceId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.deserializeAccount(r));
  }

  private mergeSignedDatesIntoReservations(
    accountKey: string,
    reservations: SignReservation[],
    nowIso: string
  ): SignReservation[] {
    const upsertSigned = this.db.prepare(`
      INSERT OR IGNORE INTO signed_records (
        account_key, reservation_id, date_key, signed_at, detail
      ) VALUES (?, ?, ?, ?, ?)
    `);

    for (const res of reservations) {
      if (res.signedDates && typeof res.signedDates === 'object') {
        for (const [dateKey, signedAt] of Object.entries(res.signedDates)) {
          if (dateKey) {
            upsertSigned.run(
              accountKey,
              res.id,
              dateKey,
              String(signedAt || nowIso),
              '客户端同步'
            );
          }
        }
      }
    }

    const existingSigned = this.db
      .prepare(
        'SELECT reservation_id, date_key, signed_at FROM signed_records WHERE account_key = ?'
      )
      .all(accountKey) as Array<{
      reservation_id: string;
      date_key: string;
      signed_at: string;
    }>;

    const byRes = new Map<string, Record<string, string>>();
    for (const row of existingSigned) {
      const map = byRes.get(row.reservation_id) ?? {};
      map[row.date_key] = row.signed_at;
      byRes.set(row.reservation_id, map);
    }

    return reservations.map((res) => {
      const dbDates = byRes.get(res.id);
      if (!dbDates) return res;
      return {
        ...res,
        signedDates: {
          ...(res.signedDates ?? {}),
          ...dbDates,
        },
      };
    });
  }

  /**
   * 首次上云建档（仅当 account_key 尚不存在时创建 rev=1，并绑定当前设备）。
   * 若并发竞态下已存在同 key 账号，校验元信息一致后返回 created=false。
   */
  seedNewAccount(params: {
    accountKey: string;
    platform: PlatformType;
    server?: RainClassroomServerType;
    uid: string;
    name: string;
    cookies: Record<string, string>;
    cookiesUpdatedAt?: number;
    deviceInfo?: AccountDeviceInfo | null;
    config?: AccountConfigPayload | null;
    device: DeviceMeta;
    nowMs?: number;
  }): { account: StoredAccount; created: boolean } {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = formatUtc8Iso(nowMs);
    const server: RainClassroomServerType = params.server ?? 'yuketang';
    const cookiesTs = this.clampCookieTimestamp(
      params.cookiesUpdatedAt,
      0,
      false,
      nowMs
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getAccount(params.accountKey);
      if (existing) {
        if (
          existing.platform !== params.platform ||
          String(existing.uid) !== String(params.uid) ||
          (existing.platform === 'rainClassroom' && existing.server !== server)
        ) {
          throw new Error('ACCOUNT_IDENTITY_MISMATCH');
        }
        this.bindOrTouchDeviceInternal(params.accountKey, params.device, nowIso, nowMs);
        this.db.exec('COMMIT');
        return { account: existing, created: false };
      }

      const timetable = Array.isArray(params.config?.timetable)
        ? params.config!.timetable
        : [];
      const rawReservations = Array.isArray(params.config?.reservations)
        ? params.config!.reservations
        : [];
      const reservations = this.mergeSignedDatesIntoReservations(
        params.accountKey,
        rawReservations,
        nowIso
      );
      const courseLocations = params.config?.courseLocations ?? {};
      const aiConfig = params.config?.aiConfig ?? null;

      this.db
        .prepare(
          `INSERT INTO accounts (
            account_key, platform, server, uid, name,
            cookies_enc, cookies_updated_at, device_info_enc,
            semester_start_monday, timetable_json, reservations_json,
            course_locations_json, ai_config_enc,
            config_rev, config_updated_at, last_editor_device_id,
            session_status, session_error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'ok', '', ?)`
        )
        .run(
          params.accountKey,
          params.platform,
          server,
          String(params.uid),
          (params.name ?? '').trim() || String(params.uid),
          this.secretBox.encrypt(JSON.stringify(params.cookies)),
          cookiesTs,
          this.secretBox.encrypt(JSON.stringify(params.deviceInfo ?? {})),
          params.config?.semesterStartMonday ?? null,
          JSON.stringify(timetable),
          JSON.stringify(reservations),
          JSON.stringify(courseLocations),
          aiConfig ? this.secretBox.encrypt(JSON.stringify(aiConfig)) : '',
          nowIso,
          params.device.deviceId,
          nowIso
        );

      this.bindOrTouchDeviceInternal(params.accountKey, params.device, nowIso, nowMs);
      this.db.exec('COMMIT');
      return { account: this.getAccount(params.accountKey)!, created: true };
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  /**
   * 显式更新已存在账号的配置（递增 config_rev，合并 signedDates，不改写平台/服务器/UID，防止空 API Key 误清空）。
   */
  updateAccountConfig(params: {
    accountKey: string;
    platform: PlatformType;
    server?: RainClassroomServerType;
    uid: string;
    name: string;
    cookies?: Record<string, string>;
    cookiesUpdatedAt?: number;
    forceAcceptCookies?: boolean;
    deviceInfo?: AccountDeviceInfo | null;
    semesterStartMonday?: string | null;
    timetable: TimetableCourse[];
    reservations: SignReservation[];
    courseLocations?: Record<string, CourseLocationPreset>;
    aiConfig?: AiConfig | null;
    allowClearApiKey?: boolean;
    device: DeviceMeta;
    nowMs?: number;
  }): StoredAccount {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = formatUtc8Iso(nowMs);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getAccount(params.accountKey);
      if (!existing) {
        this.db.exec('COMMIT');
        return this.seedNewAccount({
          accountKey: params.accountKey,
          platform: params.platform,
          server: params.server,
          uid: params.uid,
          name: params.name,
          cookies: params.cookies ?? {},
          cookiesUpdatedAt: params.cookiesUpdatedAt,
          deviceInfo: params.deviceInfo,
          config: {
            semesterStartMonday: params.semesterStartMonday ?? null,
            timetable: params.timetable,
            reservations: params.reservations,
            courseLocations: params.courseLocations ?? {},
            aiConfig: params.aiConfig ?? null,
          },
          device: params.device,
          nowMs,
        }).account;
      }

      const mergedAi = mergeAiConfigSafe(
        params.aiConfig,
        existing.aiConfig,
        Boolean(params.allowClearApiKey)
      );
      const mergedReservations = this.mergeSignedDatesIntoReservations(
        params.accountKey,
        Array.isArray(params.reservations) ? params.reservations : [],
        nowIso
      );

      let nextCookies = existing.cookies;
      let nextCookiesTs = existing.cookiesUpdatedAt;
      let nextStatus = existing.sessionStatus;
      let nextError = existing.sessionError;

      const incCookies = params.cookies ?? {};
      const hasIncCookies = Object.keys(incCookies).length > 0;
      const incTs = params.cookiesUpdatedAt ?? 0;
      const forceAcc =
        params.forceAcceptCookies === true ||
        existing.sessionStatus !== 'ok' ||
        Object.keys(existing.cookies).length === 0;
      if (hasIncCookies && (forceAcc || incTs > existing.cookiesUpdatedAt)) {
        nextCookies = incCookies;
        nextCookiesTs = this.clampCookieTimestamp(
          params.cookiesUpdatedAt,
          existing.cookiesUpdatedAt,
          forceAcc,
          nowMs
        );
        nextStatus = 'ok';
        nextError = '';
      }

      const nextDeviceInfo =
        params.deviceInfo && Object.keys(params.deviceInfo).length > 0
          ? params.deviceInfo
          : existing.deviceInfo;

      const nextRev = existing.configRev + 1;
      const nextSemester =
        params.semesterStartMonday !== undefined
          ? params.semesterStartMonday
          : existing.semesterStartMonday;

      this.db
        .prepare(
          `UPDATE accounts SET
            name = ?,
            cookies_enc = ?,
            cookies_updated_at = ?,
            device_info_enc = ?,
            semester_start_monday = ?,
            timetable_json = ?,
            reservations_json = ?,
            course_locations_json = ?,
            ai_config_enc = ?,
            config_rev = ?,
            config_updated_at = ?,
            last_editor_device_id = ?,
            session_status = ?,
            session_error = ?,
            updated_at = ?
           WHERE account_key = ?`
        )
        .run(
          (params.name ?? '').trim() || existing.name,
          this.secretBox.encrypt(JSON.stringify(nextCookies)),
          nextCookiesTs,
          this.secretBox.encrypt(JSON.stringify(nextDeviceInfo)),
          nextSemester,
          JSON.stringify(Array.isArray(params.timetable) ? params.timetable : []),
          JSON.stringify(mergedReservations),
          JSON.stringify(params.courseLocations ?? existing.courseLocations),
          mergedAi ? this.secretBox.encrypt(JSON.stringify(mergedAi)) : '',
          nextRev,
          nowIso,
          params.device.deviceId,
          nextStatus,
          nextError,
          nowIso,
          params.accountKey
        );

      this.bindOrTouchDeviceInternal(params.accountKey, params.device, nowIso, nowMs);
      this.db.exec('COMMIT');
      return this.getAccount(params.accountKey)!;
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  /**
   * 仅在传入 Cookie 更新鲜（或云端登录态已过期/为空）时刷新 Cookie，绝不覆盖更新的云端凭证。
   */
  refreshAccountCookiesIfFresher(params: {
    accountKey: string;
    cookies: Record<string, string>;
    cookiesUpdatedAt?: number;
    deviceInfo?: AccountDeviceInfo | null;
    name?: string;
    forceAccept?: boolean;
    nowMs?: number;
  }): boolean {
    const existing = this.getAccount(params.accountKey);
    if (!existing) return false;
    if (Object.keys(params.cookies).length === 0) return false;

    const nowMs = params.nowMs ?? Date.now();
    const incTs = params.cookiesUpdatedAt ?? 0;
    const forceAcc =
      params.forceAccept === true ||
      existing.sessionStatus !== 'ok' ||
      Object.keys(existing.cookies).length === 0;
    if (!forceAcc && incTs <= existing.cookiesUpdatedAt) return false;

    const nextDeviceInfo =
      params.deviceInfo && Object.keys(params.deviceInfo).length > 0
        ? params.deviceInfo
        : existing.deviceInfo;
    const nextName = (params.name ?? '').trim() || existing.name;
    const nextTs = this.clampCookieTimestamp(
      params.cookiesUpdatedAt,
      existing.cookiesUpdatedAt,
      forceAcc,
      nowMs
    );

    this.db
      .prepare(
        `UPDATE accounts SET
          name = ?,
          cookies_enc = ?,
          cookies_updated_at = ?,
          device_info_enc = ?,
          session_status = 'ok',
          session_error = '',
          updated_at = ?
         WHERE account_key = ?`
      )
      .run(
        nextName,
        this.secretBox.encrypt(JSON.stringify(params.cookies)),
        nextTs,
        this.secretBox.encrypt(JSON.stringify(nextDeviceInfo)),
        formatUtc8Iso(nowMs),
        params.accountKey
      );
    return true;
  }

  /**
   * 返回合并了 signed_records 表的预约列表，确保新绑定设备拉取配置时自带完整已签徽标。
   */
  getMergedReservationsForAccount(account: StoredAccount): SignReservation[] {
    const rows = this.db
      .prepare(
        'SELECT reservation_id, date_key, signed_at FROM signed_records WHERE account_key = ?'
      )
      .all(account.accountKey) as Array<{
      reservation_id: string;
      date_key: string;
      signed_at: string;
    }>;
    if (rows.length === 0) return account.reservations;

    const byRes = new Map<string, Record<string, string>>();
    for (const r of rows) {
      const m = byRes.get(r.reservation_id) ?? {};
      m[r.date_key] = r.signed_at;
      byRes.set(r.reservation_id, m);
    }
    return account.reservations.map((res) => {
      const dbDates = byRes.get(res.id);
      if (!dbDates) return res;
      return {
        ...res,
        signedDates: {
          ...(res.signedDates ?? {}),
          ...dbDates,
        },
      };
    });
  }

  /**
   * 单设备解绑（引用计数）：仅当剩余绑定设备数为 0 时，才彻底删除账号数据。
   */
  unbindDevice(
    accountKey: string,
    targetDeviceId: string
  ): { unbound: boolean; remainingDevices: number; accountRemoved: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const del = this.db
        .prepare(
          'DELETE FROM account_devices WHERE account_key = ? AND device_id = ?'
        )
        .run(accountKey, targetDeviceId);
      const unbound = Number(del.changes) > 0;

      const countRow = this.db
        .prepare('SELECT COUNT(*) AS c FROM account_devices WHERE account_key = ?')
        .get(accountKey) as { c: number };
      const remainingDevices = Number(countRow?.c ?? 0);

      let accountRemoved = false;
      if (remainingDevices === 0) {
        accountRemoved = this.deleteAccountInternal(accountKey);
      }
      this.db.exec('COMMIT');
      return { unbound, remainingDevices, accountRemoved };
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  /**
   * 强制删除账号并清空全部设备绑定（一键彻底停止云端托管）。
   */
  forceRemoveAccount(accountKey: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.deleteAccountInternal(accountKey);
      this.db.exec('COMMIT');
      return removed;
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  /**
   * 清理超过 maxAgeMs（默认 14 天）未活跃的幽灵设备以及无绑定设备的孤儿账号。
   */
  pruneStaleDevices(
    maxAgeMs = 14 * 24 * 60 * 60 * 1000,
    nowMs = Date.now()
  ): { prunedBindings: number; stoppedAccountKeys: string[] } {
    const cutoffMs = nowMs - maxAgeMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const affected = this.db
        .prepare(
          'SELECT DISTINCT account_key FROM account_devices WHERE last_seen_ms < ?'
        )
        .all(cutoffMs) as Array<{ account_key: string }>;

      const del = this.db
        .prepare('DELETE FROM account_devices WHERE last_seen_ms < ?')
        .run(cutoffMs);
      const prunedBindings = Number(del.changes);

      const orphanRows = this.db
        .prepare(
          `SELECT account_key FROM accounts
           WHERE NOT EXISTS (
             SELECT 1 FROM account_devices d WHERE d.account_key = accounts.account_key
           )`
        )
        .all() as Array<{ account_key: string }>;

      const candidates = new Set<string>([
        ...affected.map((r) => r.account_key),
        ...orphanRows.map((r) => r.account_key),
      ]);

      const stoppedAccountKeys: string[] = [];
      for (const accKey of candidates) {
        const cRow = this.db
          .prepare('SELECT COUNT(*) AS c FROM account_devices WHERE account_key = ?')
          .get(accKey) as { c: number };
        if (Number(cRow?.c ?? 0) === 0) {
          if (this.deleteAccountInternal(accKey)) {
            stoppedAccountKeys.push(accKey);
          }
        }
      }

      this.db.exec('COMMIT');
      return { prunedBindings, stoppedAccountKeys };
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  private deleteAccountInternal(accountKey: string): boolean {
    this.db
      .prepare('DELETE FROM account_devices WHERE account_key = ?')
      .run(accountKey);
    const info = this.db
      .prepare('DELETE FROM accounts WHERE account_key = ?')
      .run(accountKey);
    this.db
      .prepare('DELETE FROM signed_records WHERE account_key = ?')
      .run(accountKey);
    this.db
      .prepare('DELETE FROM answered_problems WHERE account_key = ?')
      .run(accountKey);
    this.db
      .prepare('DELETE FROM execution_logs WHERE account_key = ?')
      .run(accountKey);
    return Number(info.changes) > 0;
  }

  /**
   * 后台调度收到平台 Set-Cookie 时，仅按增量键合并进当前库内 Cookie（不改写 cookies_updated_at，避免覆盖新同步的 sessionid）。
   */
  updateAccountCookies(
    accountKey: string,
    deltaCookies: Record<string, string>
  ): void {
    if (Object.keys(deltaCookies).length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getAccount(accountKey);
      if (!existing) {
        this.db.exec('COMMIT');
        return;
      }
      const merged = { ...existing.cookies, ...deltaCookies };
      const enc = this.secretBox.encrypt(JSON.stringify(merged));
      this.db
        .prepare(
          `UPDATE accounts SET cookies_enc = ?, updated_at = ?
           WHERE account_key = ?`
        )
        .run(enc, formatUtc8Iso(), accountKey);
      this.db.exec('COMMIT');
    } catch (err) {
      this.safeRollback();
      throw err;
    }
  }

  setAccountSessionStatus(
    accountKey: string,
    status: AccountSessionStatus,
    error = ''
  ): void {
    this.db
      .prepare(
        `UPDATE accounts SET session_status = ?, session_error = ?, updated_at = ?
         WHERE account_key = ?`
      )
      .run(status, error, formatUtc8Iso(), accountKey);
  }

  getAllAccounts(): StoredAccount[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeAccount(row));
  }

  getAccount(accountKey: string): StoredAccount | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE account_key = ?')
      .get(accountKey) as Record<string, unknown> | undefined;
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
      accountKey: String(row.account_key),
      platform:
        row.platform === 'chaoxing' ? 'chaoxing' : ('rainClassroom' as PlatformType),
      server: (row.server as RainClassroomServerType) || 'yuketang',
      uid: String(row.uid),
      name: String(row.name),
      cookies: safeParse<Record<string, string>>(cookiesRaw, {}),
      cookiesUpdatedAt: Number(row.cookies_updated_at ?? 0),
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
      configRev: Number(row.config_rev ?? 1),
      configUpdatedAt: String(row.config_updated_at ?? row.updated_at ?? ''),
      lastEditorDeviceId: String(row.last_editor_device_id ?? ''),
      sessionStatus: (row.session_status as AccountSessionStatus) || 'ok',
      sessionError: String(row.session_error ?? ''),
      updatedAt: String(row.updated_at ?? ''),
    };
  }

  isReservationSigned(
    accountKey: string,
    reservationId: string,
    dateKey: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM signed_records
         WHERE account_key = ? AND reservation_id = ? AND date_key = ?`
      )
      .get(accountKey, reservationId, dateKey);
    return Boolean(row);
  }

  markReservationSigned(
    accountKey: string,
    reservationId: string,
    dateKey: string,
    detail = ''
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO signed_records (
          account_key, reservation_id, date_key, signed_at, detail
        ) VALUES (?, ?, ?, ?, ?)`
      )
      .run(accountKey, reservationId, dateKey, formatUtc8Iso(), detail);
  }

  getSignedMapForAccounts(
    accountKeys: string[]
  ): Record<string, Record<string, Record<string, string>>> {
    if (accountKeys.length === 0) return {};
    const placeholders = accountKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT account_key, reservation_id, date_key, signed_at
         FROM signed_records WHERE account_key IN (${placeholders})`
      )
      .all(...accountKeys) as Array<{
      account_key: string;
      reservation_id: string;
      date_key: string;
      signed_at: string;
    }>;

    const out: Record<string, Record<string, Record<string, string>>> = {};
    for (const r of rows) {
      out[r.account_key] ??= {};
      out[r.account_key][r.reservation_id] ??= {};
      out[r.account_key][r.reservation_id][r.date_key] = r.signed_at;
    }
    return out;
  }

  isProblemAnswered(
    accountKey: string,
    lessonId: string,
    problemId: string
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM answered_problems
         WHERE account_key = ? AND lesson_id = ? AND problem_id = ?`
      )
      .get(accountKey, lessonId, problemId);
    return Boolean(row);
  }

  markProblemAnswered(
    accountKey: string,
    lessonId: string,
    problemId: string
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO answered_problems (
          account_key, lesson_id, problem_id, answered_at
        ) VALUES (?, ?, ?, ?)`
      )
      .run(accountKey, lessonId, problemId, formatUtc8Iso());
  }

  addLog(entry: {
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
          account_key, account_name, platform, category,
          level, title, detail, course_name, lesson_id, problem_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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

    // 按账号保留最近 N 条日志，防止低配机器 SQLite 膨胀
    this.db
      .prepare(
        `DELETE FROM execution_logs
         WHERE account_key = ?
           AND id NOT IN (
             SELECT id FROM execution_logs
             WHERE account_key = ?
             ORDER BY id DESC
             LIMIT ?
           )`
      )
      .run(entry.accountKey, entry.accountKey, this.maxLogsPerAccount);

    return {
      id: Number(res.lastInsertRowid),
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

  getLogsForAccounts(accountKeys: string[], limit = 80): ExecutionLogItem[] {
    if (accountKeys.length === 0) return [];
    const placeholders = accountKeys.map(() => '?').join(', ');
    const safeLimit = Math.max(1, Math.min(300, limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_logs
         WHERE account_key IN (${placeholders})
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(...accountKeys, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: Number(r.id),
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

  getStats(): { workspaces: number; accounts: number; devices: number } {
    const w = this.db
      .prepare('SELECT COUNT(DISTINCT device_id) AS c FROM account_devices')
      .get() as { c: number };
    const a = this.db
      .prepare('SELECT COUNT(*) AS c FROM accounts')
      .get() as { c: number };
    const d = this.db
      .prepare('SELECT COUNT(*) AS c FROM account_devices')
      .get() as { c: number };
    return {
      workspaces: Number(w?.c ?? 0),
      accounts: Number(a?.c ?? 0),
      devices: Number(d?.c ?? 0),
    };
  }
}

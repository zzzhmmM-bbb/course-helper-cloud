import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  containsPhotoKeyword,
  parseAiJsonObject,
  validateChoiceOptions,
} from '../src/ai/vision_solver.js';
import { resolveLocationForSignIn } from '../src/campus.js';
import { loadConfig, Logger } from '../src/config.js';
import {
  bd09ToGcj02,
  buildCxLocationResultJson,
  buildCxUserAgent,
  gcj02ToBd09,
  getCxEncParams,
  SecretBox,
} from '../src/crypto.js';
import { CloudDatabase } from '../src/db.js';
import { RcAutoAnswerEngine } from '../src/engines/rc_auto_answer.js';
import {
  CloudSchedulerEngine,
  fuzzyMatchOnlineCourse,
} from '../src/engines/scheduler.js';
import {
  parseLocationEligibility,
  requiresPendingLocationSignIn,
} from '../src/protocols/rainclassroom.js';
import { createCloudServer } from '../src/server.js';
import {
  academicWeekForEpoch,
  computeSlotEpochsUtc8,
  defaultWatchWindowForCourse,
  getUtc8Parts,
  utc8EpochMs,
} from '../src/time.js';
import type { SignReservation, TimetableCourse } from '../src/types.js';

describe('Crypto & ChaoXing signing', () => {
  it('encrypts and decrypts secrets with AES-256-GCM and rejects tampering', () => {
    const box = new SecretBox('super-secret-master-key-32-chars!!');
    const cipher = box.encrypt('sessionid=abc123; csrftoken=xyz');
    assert.ok(cipher.startsWith('v1:'));
    assert.equal(box.decrypt(cipher), 'sessionid=abc123; csrftoken=xyz');

    const lastChar = cipher.at(-1);
    const tampered = `${cipher.slice(0, -1)}${lastChar === 'A' ? 'B' : 'A'}`;
    assert.throws(() => box.decrypt(tampered));
  });

  it('builds valid ChaoXing enc params, UA, and locationResult JSON', () => {
    const enc = getCxEncParams({ courseId: '101', classId: '202' });
    assert.equal(enc.inf_enc.length, 32);
    assert.ok(enc._c_0_.length === 32);

    const ua = buildCxUserAgent('abcdef1234567890');
    assert.ok(ua.includes('(schild:'));
    assert.ok(ua.includes('ChaoXingStudy_3_6.7.4'));

    const locJson = JSON.parse(
      buildCxLocationResultJson(
        { cid: 'cid1', sc: 'sc1' },
        '明德楼A201',
        22.04935,
        113.40065
      )
    );
    assert.equal(locJson.result, 1);
    assert.equal(locJson.signConfig.cxcid, 'cid1');
    assert.equal(locJson.signConfig.signToken.length, 32);
  });

  it('converts BD-09 and GCJ-02 coordinates cleanly round-trip', () => {
    const gcj = { lat: 22.04935, lng: 113.40065 };
    const bd = gcj02ToBd09(gcj.lat, gcj.lng);
    const back = bd09ToGcj02(bd.latitude, bd.longitude);
    assert.ok(Math.abs(back.latitude - gcj.lat) < 0.0001);
    assert.ok(Math.abs(back.longitude - gcj.lng) < 0.0001);
  });
});

describe('UTC+8 time & ZCST section watch windows', () => {
  it('maps 1-2/3-4/5-6/7-8/9-10 sections to default 2-min early watch times', () => {
    assert.deepEqual(
      defaultWatchWindowForCourse({ startSection: 1, endSection: 2 }),
      { defaultTriggerHour: 7, defaultTriggerMinute: 58, endHour: 9, endMinute: 55 }
    );
    assert.deepEqual(
      defaultWatchWindowForCourse({ startSection: 3, endSection: 4 }),
      { defaultTriggerHour: 10, defaultTriggerMinute: 8, endHour: 12, endMinute: 5 }
    );
    assert.deepEqual(
      defaultWatchWindowForCourse({ startSection: 5, endSection: 6 }),
      { defaultTriggerHour: 13, defaultTriggerMinute: 58, endHour: 15, endMinute: 45 }
    );
    assert.deepEqual(
      defaultWatchWindowForCourse({ startSection: 7, endSection: 8 }),
      { defaultTriggerHour: 15, defaultTriggerMinute: 58, endHour: 17, endMinute: 45 }
    );
    assert.deepEqual(
      defaultWatchWindowForCourse({ startSection: 9, endSection: 10 }),
      { defaultTriggerHour: 18, defaultTriggerMinute: 58, endHour: 20, endMinute: 45 }
    );
  });

  it('computes academic week and per-course custom trigger time in UTC+8', () => {
    const startMonday = '2026-09-07';
    const week2Wed = utc8EpochMs(2026, 9, 16, 8, 5, 0);
    assert.equal(academicWeekForEpoch(startMonday, week2Wed), 2);

    const course: TimetableCourse = {
      id: 'c1',
      name: '高等数学',
      teacher: '张老师',
      classroom: '明德楼A201',
      weekday: 3,
      startSection: 1,
      endSection: 2,
      weeks: [1, 2, 3],
    };
    const defaultRes: SignReservation = {
      id: 'r1',
      timetableCourseId: 'c1',
      courseName: '高等数学',
      targetWeek: 2,
      enabled: true,
      useCustomTime: false,
      customHour: 8,
      customMinute: 5,
    };
    const slotDefault = computeSlotEpochsUtc8(startMonday, course, defaultRes, 2);
    const pDefault = getUtc8Parts(slotDefault.triggerEpochMs);
    assert.equal(pDefault.dateKey, '2026-09-16');
    assert.equal(pDefault.hour, 7);
    assert.equal(pDefault.minute, 58);

    const customRes: SignReservation = { ...defaultRes, useCustomTime: true, customHour: 8, customMinute: 7 };
    const slotCustom = computeSlotEpochsUtc8(startMonday, course, customRes, 2);
    const pCustom = getUtc8Parts(slotCustom.triggerEpochMs);
    assert.equal(pCustom.hour, 8);
    assert.equal(pCustom.minute, 7);
  });
});

describe('Campus GPS fallback & RC eligibility', () => {
  it('prioritizes preset > teacher center > ZCST building fallback', () => {
    const presetLoc = resolveLocationForSignIn({
      targetCoord: 'gcj02',
      preset: { address: '自选教室', latitude: 22.05, longitude: 113.4, coordType: 'gcj02' },
      teacherLat: 22.06,
      teacherLng: 113.41,
      classroom: '明德楼A201',
    });
    assert.equal(presetLoc.source, 'preset');

    const teacherLoc = resolveLocationForSignIn({
      targetCoord: 'gcj02',
      teacherLat: 22.055,
      teacherLng: 113.405,
      teacherAddress: '明德楼',
      classroom: '明德楼A201',
    });
    assert.equal(teacherLoc.source, 'teacher_center');
    assert.ok(Math.abs(teacherLoc.latitude - 22.055) < 0.0005);

    const campusLoc = resolveLocationForSignIn({
      targetCoord: 'bd09',
      classroom: '国学院K302',
    });
    assert.equal(campusLoc.source, 'campus_fallback');
    assert.ok(campusLoc.address.includes('国学院'));
  });

  it('parses RainClassroom location eligibility accurately', () => {
    const elig = parseLocationEligibility({
      code: 0,
      data: {
        needLocationSignIn: true,
        signed: false,
        canSign: true,
        session: {
          centerLat: '22.04935',
          centerLng: '113.40065',
          locationName: '明德楼',
        },
      },
    });
    assert.equal(requiresPendingLocationSignIn(elig), true);
    assert.equal(elig.centerLat, 22.04935);
    assert.equal(elig.address, '明德楼');
  });
});

describe('AI solver parsing & validation', () => {
  it('parses fenced JSON, splits combined choice keys, and detects photo keywords', () => {
    const parsed = parseAiJsonObject(
      '```json\n{"options":["AB"],"reason":"显然"}\n```'
    );
    assert.deepEqual(parsed.options, ['AB']);

    const validated = validateChoiceOptions({
      rawOptions: ['BA'],
      validKeys: ['A', 'B', 'C', 'D'],
      problemType: 2,
    });
    assert.deepEqual(validated, ['A', 'B']);

    assert.equal(containsPhotoKeyword('请在纸上写出推导过程并拍照上传'), true);
    assert.equal(containsPhotoKeyword('简述操作系统的三大特征'), false);

    const hit = fuzzyMatchOnlineCourse('高等数学（上）', [
      { courseId: '1', classId: '2', name: '高等数学(上)-2026', teacher: '李' },
    ]);
    assert.equal(hit?.courseId, '1');
  });
});

import {
  hasConsistentChaoXingUid,
  matchesStoredSessionToken,
  type OwnershipVerifier,
} from '../src/protocols/ownership.js';

describe('Multi-device v2 sync, ownership security, migration & legacy compat', () => {
  function createTestHarness(opts?: {
    tmpDir?: string;
    ownershipVerifier?: OwnershipVerifier;
  }) {
    const tmpDir =
      opts?.tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'litecourse-cloud-'));
    const config = loadConfig({
      PORT: '0',
      ACCESS_CODE: 'test-access-secret-999',
      ENCRYPTION_KEY: 'test-encryption-master-key-32-bytes!',
      DATA_DIR: tmpDir,
      SEMESTER_START_MONDAY: '2026-09-07',
      LOG_LEVEL: 'error',
    });
    const logger = new Logger('error');
    const db = new CloudDatabase({
      dataDir: config.dataDir,
      encryptionKey: config.encryptionKey,
    });
    const rcEngine = new RcAutoAnswerEngine(db, logger);
    const scheduler = new CloudSchedulerEngine(config, db, rcEngine, logger);
    const server = createCloudServer({
      config,
      db,
      rcAutoAnswer: rcEngine,
      scheduler,
      logger,
      ownershipVerifier: opts?.ownershipVerifier,
    });
    return { tmpDir, config, logger, db, rcEngine, scheduler, server };
  }

  it('encrypts secrets at rest, isolates unbound devices, and preserves legacy /api/sync', async () => {
    const mockVerifier: OwnershipVerifier = async ({ uid, cookies }) => {
      const ok =
        cookies.sessionid === `VALID_SID_${uid}` ||
        (cookies.UID === uid && cookies.vc3 === `VALID_VC3_${uid}`);
      return ok
        ? { ok: true, actualUid: uid }
        : { ok: false, expired: false, reason: 'UID 归属不匹配' };
    };
    const h = createTestHarness({ ownershipVerifier: mockVerifier });
    await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', resolve));
    const addr = h.server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const healthResp = await fetch(`${baseUrl}/health`);
      assert.equal(healthResp.status, 200);
      const health = (await healthResp.json()) as Record<string, unknown>;
      assert.equal(health.ok, true);
      assert.equal(health.apiVersion, 2);

      const unauth = await fetch(`${baseUrl}/api/status`, {
        headers: { 'X-Access-Code': 'wrong', 'X-User-Token': 'user_token_alpha_1' },
      });
      assert.equal(unauth.status, 401);

      const syncA = await fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-User-Token': 'user_token_alpha_1',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              cookies: { sessionid: 'VALID_SID_10001', csrftoken: 'csrf1' },
              timetable: [],
              reservations: [],
              aiConfig: {
                enabled: true,
                providerId: 'glm',
                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                apiKey: 'sk-SECRET-API-KEY-ALPHA',
                model: 'glm-4.1v-thinking-flash',
                autoSubmitSubjective: false,
                autoRetryExpired: false,
              },
            },
            {
              accountKey: 'cx:20002',
              platform: 'chaoxing',
              uid: '20002',
              name: '同学甲学习通',
              cookies: 'UID=20002; vc3=VALID_VC3_20002; _d=12345',
              timetable: [],
              reservations: [],
            },
          ],
        }),
      });
      assert.equal(syncA.status, 200);
      const syncAData = (await syncA.json()) as Record<string, unknown>;
      assert.equal(syncAData.syncedCount, 2);

      // Verify SQLite file encrypts cookies & AI key at rest
      const rawDb = new DatabaseSync(path.join(h.tmpDir, 'cloud.db'));
      const rawRow = rawDb
        .prepare('SELECT cookies_enc, ai_config_enc FROM accounts WHERE account_key = ?')
        .get('rc:yuketang_10001') as { cookies_enc: string; ai_config_enc: string };
      rawDb.close();
      assert.ok(!rawRow.cookies_enc.includes('VALID_SID_10001'));
      assert.ok(!rawRow.ai_config_enc.includes('sk-SECRET-API-KEY-ALPHA'));

      // Unbound device B cannot see device A's accounts
      const statusB = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'X-Access-Code': h.config.accessCode,
          'X-User-Token': 'user_token_beta_2',
        },
      });
      const statusBData = (await statusB.json()) as { accounts: unknown[] };
      assert.equal(statusBData.accounts.length, 0);

      // Delete cx:20002 (only 1 bound device -> account stopped & removed)
      const delResp = await fetch(
        `${baseUrl}/api/accounts/${encodeURIComponent('cx:20002')}`,
        {
          method: 'DELETE',
          headers: {
            'X-Access-Code': h.config.accessCode,
            'X-User-Token': 'user_token_alpha_1',
          },
        }
      );
      assert.equal(delResp.status, 200);
      const delData = (await delResp.json()) as {
        removed: boolean;
        accountStopped: boolean;
      };
      assert.equal(delData.removed, true);
      assert.equal(delData.accountStopped, true);

      const statusA = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'X-Access-Code': h.config.accessCode,
          'X-User-Token': 'user_token_alpha_1',
        },
      });
      const statusAData = (await statusA.json()) as {
        accounts: Array<{ accountKey: string }>;
      };
      assert.equal(statusAData.accounts.length, 1);
      assert.equal(statusAData.accounts[0].accountKey, 'rc:yuketang_10001');
    } finally {
      h.scheduler.stop();
      h.rcEngine.shutdown();
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      h.db.close();
      fs.rmSync(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('syncs config bidirectionally across phone & tablet, blocks UID spoofing, preserves API key & signedDates, and uses reference-counted unbind', async () => {
    const mockVerifier: OwnershipVerifier = async ({ uid, cookies }) => {
      if (cookies.sessionid === `LIVE_SID_${uid}` || cookies.sessionid === `FRESH_SID_${uid}`) {
        return { ok: true, actualUid: uid };
      }
      if (cookies.sessionid === 'EXPIRED_SID') {
        return { ok: false, expired: true, reason: 'Cookie 已过期' };
      }
      return { ok: false, expired: false, reason: '归属 UID 不匹配' };
    };

    const h = createTestHarness({ ownershipVerifier: mockVerifier });
    await new Promise<void>((resolve) => h.server.listen(0, '127.0.0.1', resolve));
    const addr = h.server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const course1: TimetableCourse = {
      id: 'c1',
      name: '高等数学',
      teacher: '王老师',
      classroom: '明德楼A201',
      weekday: 1,
      startSection: 1,
      endSection: 2,
      weeks: [1, 2, 3, 4],
    };
    const res1: SignReservation = {
      id: 'res_1',
      timetableCourseId: 'c1',
      courseName: '高等数学',
      targetWeek: 2,
      enabled: true,
      useCustomTime: false,
      customHour: 8,
      customMinute: 0,
      signedDates: { '2026-09-14': '07:59' },
    };

    try {
      // 1. Phone seeds account via /api/v2/sync/pull
      const phonePull1 = await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_phone_001',
        },
        body: JSON.stringify({
          deviceName: 'Xiaomi 14',
          platformOs: 'android',
          isTablet: false,
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              knownRev: 0,
              cookies: { sessionid: 'LIVE_SID_10001' },
              cookiesUpdatedAt: 2000,
              initialConfig: {
                semesterStartMonday: '2026-09-07',
                timetable: [course1],
                reservations: [res1],
                courseLocations: {
                  course_101: {
                    address: '明德楼A201',
                    latitude: 22.05,
                    longitude: 113.4,
                    coordType: 'gcj02',
                  },
                },
                aiConfig: {
                  enabled: true,
                  providerId: 'glm',
                  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                  apiKey: 'sk-PHONE-SECRET-KEY',
                  model: 'glm-4.1v-thinking-flash',
                  autoSubmitSubjective: false,
                  autoRetryExpired: true,
                },
              },
            },
          ],
        }),
      });
      assert.equal(phonePull1.status, 200);
      const p1 = (await phonePull1.json()) as Record<string, any>;
      assert.equal(p1.pulledAccounts['rc:yuketang_10001'].status, 'created');
      assert.equal(p1.pulledAccounts['rc:yuketang_10001'].configRev, 1);

      // 2. Attacker spoofs victim accountKey with (a) wrong cookie, (b) attacker's OWN uid + valid cookie, (c) pre-seeding nonexistent accountKey
      const attackerPull = await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_attacker_999',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '伪造者',
              knownRev: 0,
              cookies: { sessionid: 'ATTACKER_OTHER_UID_SID' },
            },
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '99999',
              name: '借刀越权者',
              knownRev: 0,
              cookies: { sessionid: 'LIVE_SID_99999' },
            },
            {
              accountKey: 'rc:yuketang_88888',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '88888',
              name: '抢注未上云账号',
              knownRev: 0,
              cookies: { sessionid: 'FAKE_SQUAT_SID' },
            },
          ],
        }),
      });
      const atkData = (await attackerPull.json()) as Record<string, any>;
      assert.equal(
        atkData.pulledAccounts['rc:yuketang_10001'].status,
        'ownership_denied'
      );
      assert.equal(atkData.pulledAccounts['rc:yuketang_10001'].config, undefined);
      assert.equal(
        atkData.pulledAccounts['rc:yuketang_88888'].status,
        'ownership_denied'
      );
      assert.equal(h.db.getAccount('rc:yuketang_88888'), null);
      assert.equal(atkData.accounts.length, 0);

      // ChaoXing UID vs _uid split cookie spoofing must be rejected
      assert.equal(
        hasConsistentChaoXingUid({ UID: '10001', _uid: '99999' }, '10001'),
        false
      );
      assert.equal(
        hasConsistentChaoXingUid({ UID: '10001', _uid: '10001' }, '10001'),
        true
      );

      // Malformed URI encoding returns HTTP 400 (not 500)
      const badUri = await fetch(`${baseUrl}/api/v2/accounts/%E0%A4%A`, {
        method: 'DELETE',
        headers: {
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_phone_001',
        },
      });
      assert.equal(badUri.status, 400);

      // Attacker cannot push config or unbind Phone
      const atkPush = await fetch(
        `${baseUrl}/api/v2/accounts/${encodeURIComponent('rc:yuketang_10001')}/config`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Access-Code': h.config.accessCode,
            'X-Device-Id': 'device_attacker_999',
          },
          body: JSON.stringify({
            platform: 'rainClassroom',
            server: 'yuketang',
            uid: '10001',
            name: '伪造者',
            cookies: { sessionid: 'ATTACKER_OTHER_UID_SID' },
            timetable: [],
            reservations: [],
          }),
        }
      );
      assert.equal(atkPush.status, 403);

      // 3. Tablet logs into SAME account (empty local state) -> auto-binds & pulls full config + API Key!
      const tabletPull1 = await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_tablet_002',
        },
        body: JSON.stringify({
          deviceName: 'iPad Pro',
          platformOs: 'ios',
          isTablet: true,
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              knownRev: 0,
              cookies: { sessionid: 'LIVE_SID_10001' },
              cookiesUpdatedAt: 1000, // older timestamp -> must NOT overwrite fresher cloud cookie
              initialConfig: {
                timetable: [],
                reservations: [],
                courseLocations: {},
                aiConfig: null,
              },
            },
          ],
        }),
      });
      assert.equal(tabletPull1.status, 200);
      const t1 = (await tabletPull1.json()) as Record<string, any>;
      assert.equal(t1.pulledAccounts['rc:yuketang_10001'].status, 'ok');
      assert.equal(t1.pulledAccounts['rc:yuketang_10001'].unchanged, false);
      assert.equal(
        t1.pulledAccounts['rc:yuketang_10001'].config.timetable.length,
        1
      );
      assert.equal(
        t1.pulledAccounts['rc:yuketang_10001'].config.aiConfig.apiKey,
        'sk-PHONE-SECRET-KEY'
      );
      assert.equal(t1.accounts[0].boundDevices.length, 2);
      // Phone is non-tablet -> Phone is primary fallback, Tablet is secondary
      assert.equal(t1.accounts[0].isPrimaryFallback, false);

      // Tablet pulls again with knownRev=1 -> unchanged: true, omits config payload
      const tabletPull2 = await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_tablet_002',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              knownRev: 1,
            },
          ],
        }),
      });
      const t2 = (await tabletPull2.json()) as Record<string, any>;
      assert.equal(t2.pulledAccounts['rc:yuketang_10001'].unchanged, true);
      assert.equal(t2.pulledAccounts['rc:yuketang_10001'].config, undefined);
      // Omitting deviceName/isTablet on follow-up pull MUST preserve 'iPad Pro' and isTablet=true!
      const tabletRec = t2.accounts[0].boundDevices.find(
        (d: Record<string, unknown>) => d.deviceId === 'device_tablet_002'
      );
      assert.equal(tabletRec.deviceName, 'iPad Pro');
      assert.equal(tabletRec.isTablet, true);
      assert.equal(t2.accounts[0].isPrimaryFallback, false);

      // 4. Tablet edits reservation + sends empty apiKey (allowClearApiKey=false) -> rev=2, preserves API key & signedDates!
      const tabletPush = await fetch(
        `${baseUrl}/api/v2/accounts/${encodeURIComponent('rc:yuketang_10001')}/config`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Access-Code': h.config.accessCode,
            'X-Device-Id': 'device_tablet_002',
          },
          body: JSON.stringify({
            platform: 'rainClassroom',
            server: 'yuketang',
            uid: '10001',
            name: '同学甲',
            baseRev: 1,
            timetable: [course1],
            reservations: [
              { ...res1, useCustomTime: true, customHour: 8, customMinute: 5, signedDates: {} },
            ],
            aiConfig: {
              enabled: true,
              providerId: 'glm',
              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
              apiKey: '',
              model: 'glm-4.1v-thinking-flash',
              autoSubmitSubjective: true,
              autoRetryExpired: true,
            },
            allowClearApiKey: false,
          }),
        }
      );
      assert.equal(tabletPush.status, 200);
      const tpData = (await tabletPush.json()) as Record<string, any>;
      assert.equal(tpData.configRev, 2);

      // 5. Phone pulls with knownRev=1 -> receives rev=2 with Tablet's edits, preserved API key & preserved signedDates!
      const phonePull2 = await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_phone_001',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              knownRev: 1,
            },
          ],
        }),
      });
      const p2 = (await phonePull2.json()) as Record<string, any>;
      assert.equal(p2.pulledAccounts['rc:yuketang_10001'].configRev, 2);
      assert.equal(p2.pulledAccounts['rc:yuketang_10001'].unchanged, false);
      const pulledCfg = p2.pulledAccounts['rc:yuketang_10001'].config;
      assert.equal(pulledCfg.reservations[0].customMinute, 5);
      assert.equal(pulledCfg.reservations[0].signedDates['2026-09-14'], '07:59');
      assert.equal(pulledCfg.aiConfig.apiKey, 'sk-PHONE-SECRET-KEY');
      assert.equal(pulledCfg.aiConfig.autoSubmitSubjective, true);
      assert.equal(p2.accounts[0].isPrimaryFallback, true);

      // 6. Legacy v1.7.0 cold start with empty config MUST NOT clobber cloud data!
      const legacyEmptySync = await fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-User-Token': 'legacy_v170_device_3',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              cookies: { sessionid: 'LIVE_SID_10001' },
              timetable: [],
              reservations: [],
            },
          ],
        }),
      });
      assert.equal(legacyEmptySync.status, 200);
      const afterLegacy = h.db.getAccount('rc:yuketang_10001')!;
      assert.equal(afterLegacy.timetable.length, 1);
      assert.equal(afterLegacy.aiConfig?.apiKey, 'sk-PHONE-SECRET-KEY');

      // Legacy v1.7.0 sends empty accounts list -> only unbinds legacy device, keeps account alive!
      await fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-User-Token': 'legacy_v170_device_3',
        },
        body: JSON.stringify({ accounts: [] }),
      });
      assert.ok(h.db.getAccount('rc:yuketang_10001') !== null);
      assert.equal(h.db.getBoundDevices('rc:yuketang_10001').length, 2);

      // 7. Cookie freshness: expired cloud session recovers when Phone sends fresh verified cookie
      h.db.setAccountSessionStatus('rc:yuketang_10001', 'session_expired', '过期测试');
      await fetch(`${baseUrl}/api/v2/sync/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': h.config.accessCode,
          'X-Device-Id': 'device_phone_001',
        },
        body: JSON.stringify({
          accounts: [
            {
              accountKey: 'rc:yuketang_10001',
              platform: 'rainClassroom',
              server: 'yuketang',
              uid: '10001',
              name: '同学甲',
              knownRev: 2,
              cookies: { sessionid: 'FRESH_SID_10001' },
              cookiesUpdatedAt: 5000,
            },
          ],
        }),
      });
      const recovered = h.db.getAccount('rc:yuketang_10001')!;
      assert.equal(recovered.sessionStatus, 'ok');
      assert.equal(recovered.cookies.sessionid, 'FRESH_SID_10001');

      // 8. Reference-counted unbind: Tablet logs out -> Phone stays hosted!
      const unbindTablet = await fetch(
        `${baseUrl}/api/v2/accounts/${encodeURIComponent('rc:yuketang_10001')}/devices/${encodeURIComponent('device_tablet_002')}`,
        {
          method: 'DELETE',
          headers: {
            'X-Access-Code': h.config.accessCode,
            'X-Device-Id': 'device_tablet_002',
          },
        }
      );
      const ub1 = (await unbindTablet.json()) as Record<string, any>;
      assert.equal(ub1.unbound, true);
      assert.equal(ub1.remainingDevices, 1);
      assert.equal(ub1.accountStopped, false);
      assert.ok(h.db.getAccount('rc:yuketang_10001') !== null);

      // Last device (Phone) force stops hosting -> completely deleted including execution_logs!
      h.db.addLog({
        accountKey: 'rc:yuketang_10001',
        accountName: '同学甲',
        platform: 'rainClassroom',
        category: 'checkin',
        level: 'success',
        title: '测试清理日志',
        detail: 'force delete should wipe logs',
      });
      assert.equal(h.db.getLogsForAccounts(['rc:yuketang_10001']).length, 1);

      const forceDel = await fetch(
        `${baseUrl}/api/v2/accounts/${encodeURIComponent('rc:yuketang_10001')}?force=true`,
        {
          method: 'DELETE',
          headers: {
            'X-Access-Code': h.config.accessCode,
            'X-Device-Id': 'device_phone_001',
          },
        }
      );
      const fd = (await forceDel.json()) as Record<string, any>;
      assert.equal(fd.accountStopped, true);
      assert.equal(fd.remainingDevices, 0);
      assert.equal(h.db.getAccount('rc:yuketang_10001'), null);
      assert.equal(h.db.getLogsForAccounts(['rc:yuketang_10001']).length, 0);
    } finally {
      h.scheduler.stop();
      h.rcEngine.shutdown();
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      h.db.close();
      fs.rmSync(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy v1 SQLite database losslessly and prunes 14-day stale ghost devices', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecourse-mig-'));
    const encKey = 'test-migration-master-key-32-chars!!';
    const box = new SecretBox(encKey);

    try {
      // Create legacy v1 schema with duplicate rows for the same account_key
      const legacy = new DatabaseSync(path.join(tmpDir, 'cloud.db'));
      legacy.exec(`
        CREATE TABLE workspaces (user_token TEXT PRIMARY KEY, created_at TEXT NOT NULL, last_sync_at TEXT NOT NULL);
        CREATE TABLE accounts (
          user_token TEXT NOT NULL, account_key TEXT NOT NULL, platform TEXT NOT NULL,
          server TEXT NOT NULL, uid TEXT NOT NULL, name TEXT NOT NULL,
          cookies_enc TEXT NOT NULL, device_info_enc TEXT NOT NULL, semester_start_monday TEXT,
          timetable_json TEXT NOT NULL, reservations_json TEXT NOT NULL, course_locations_json TEXT NOT NULL,
          ai_config_enc TEXT NOT NULL, session_status TEXT NOT NULL DEFAULT 'ok',
          session_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
          PRIMARY KEY (user_token, account_key)
        );
        CREATE TABLE signed_records (
          user_token TEXT NOT NULL, account_key TEXT NOT NULL, reservation_id TEXT NOT NULL,
          date_key TEXT NOT NULL, signed_at TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (user_token, account_key, reservation_id, date_key)
        );
        CREATE TABLE answered_problems (
          user_token TEXT NOT NULL, account_key TEXT NOT NULL, lesson_id TEXT NOT NULL,
          problem_id TEXT NOT NULL, answered_at TEXT NOT NULL,
          PRIMARY KEY (user_token, account_key, lesson_id, problem_id)
        );
        CREATE TABLE execution_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_token TEXT NOT NULL, account_key TEXT NOT NULL,
          account_name TEXT NOT NULL, platform TEXT NOT NULL, category TEXT NOT NULL,
          level TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
          course_name TEXT NOT NULL DEFAULT '', lesson_id TEXT NOT NULL DEFAULT '',
          problem_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
      `);
      legacy.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('tok_phone', '2026-11-01', '2026-11-20');
      legacy.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('tok_tablet', '2026-11-02', '2026-11-21');
      // Phone has full config; Tablet has newer timestamp but empty config -> migration must prefer non-empty config!
      legacy
        .prepare(
          `INSERT INTO accounts VALUES (?, ?, 'rainClassroom', 'yuketang', '10001', '同学甲', ?, ?, '2026-09-07', ?, '[]', '{}', ?, 'ok', '', '2026-11-20T10:00:00+08:00')`
        )
        .run(
          'tok_phone',
          'rc:yuketang_10001',
          box.encrypt(JSON.stringify({ sessionid: 'sid_1' })),
          box.encrypt('{}'),
          JSON.stringify([{ id: 'c1', name: '高数', teacher: '张', classroom: 'A101', weekday: 1, startSection: 1, endSection: 2, weeks: [1] }]),
          box.encrypt(JSON.stringify({ enabled: true, providerId: 'glm', baseUrl: 'https://x', apiKey: 'sk-1', model: 'm', autoSubmitSubjective: false, autoRetryExpired: false }))
        );
      legacy
        .prepare(
          `INSERT INTO accounts VALUES (?, ?, 'rainClassroom', 'yuketang', '10001', '同学甲', ?, ?, '2026-09-07', '[]', '[]', '{}', '', 'ok', '', '2026-11-21T10:00:00+08:00')`
        )
        .run(
          'tok_tablet',
          'rc:yuketang_10001',
          box.encrypt(JSON.stringify({ sessionid: 'sid_2' })),
          box.encrypt('{}')
        );
      legacy
        .prepare(
          `INSERT INTO signed_records VALUES ('tok_phone', 'rc:yuketang_10001', 'r1', '2026-11-20', '08:00', 'ok')`
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO answered_problems VALUES ('tok_phone', 'rc:yuketang_10001', 'L1', 'P1', '08:10')`
        )
        .run();
      legacy
        .prepare(
          `INSERT INTO execution_logs (user_token, account_key, account_name, platform, category, level, title, detail, created_at)
           VALUES ('tok_phone', 'rc:yuketang_10001', '同学甲', 'rainClassroom', 'checkin', 'success', '历史签到', 'ok', '2026-11-20T08:00:00+08:00')`
        )
        .run();
      legacy.close();

      // Open with v2 CloudDatabase -> triggers automatic lossless migration
      const db = new CloudDatabase({ dataDir: tmpDir, encryptionKey: encKey });
      try {
        const all = db.getAllAccounts();
        assert.equal(all.length, 1);
        assert.equal(all[0].timetable.length, 1);
        assert.equal(all[0].aiConfig?.apiKey, 'sk-1');

        const devices = db.getBoundDevices('rc:yuketang_10001');
        assert.equal(devices.length, 2);
        assert.equal(db.isReservationSigned('rc:yuketang_10001', 'r1', '2026-11-20'), true);
        assert.equal(db.isProblemAnswered('rc:yuketang_10001', 'L1', 'P1'), true);
        assert.equal(db.getLogsForAccounts(['rc:yuketang_10001']).length, 1);

        // Fast-path token matching check
        assert.equal(
          matchesStoredSessionToken(
            'rainClassroom',
            '10001',
            { sessionid: 'sid_1' },
            all[0]
          ),
          false // sid_1 is < 8 chars so fast-path rejects short weak tokens
        );

        // 14-day stale device pruning: mark tok_tablet stale (20 days old), tok_phone fresh
        const nowMs = Date.now();
        const twentyDaysAgo = nowMs - 20 * 24 * 60 * 60 * 1000;
        db.bindOrTouchDevice('rc:yuketang_10001', { deviceId: 'tok_tablet' }, twentyDaysAgo);
        db.bindOrTouchDevice('rc:yuketang_10001', { deviceId: 'tok_phone' }, nowMs);

        const p1 = db.pruneStaleDevices(14 * 24 * 60 * 60 * 1000, nowMs);
        assert.equal(p1.prunedBindings, 1);
        assert.equal(p1.stoppedAccountKeys.length, 0);
        assert.equal(db.getBoundDevices('rc:yuketang_10001').length, 1);

        // When last remaining device also ages > 14 days -> account auto-stops
        const futureMs = nowMs + 15 * 24 * 60 * 60 * 1000;
        const p2 = db.pruneStaleDevices(14 * 24 * 60 * 60 * 1000, futureMs);
        assert.equal(p2.prunedBindings, 1);
        assert.deepEqual(p2.stoppedAccountKeys, ['rc:yuketang_10001']);
        assert.equal(db.getAccount('rc:yuketang_10001'), null);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

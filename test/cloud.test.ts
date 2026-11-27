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

    const tampered = `${cipher.slice(0, -2)}AA`;
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

describe('SQLite encryption, workspace isolation & HTTP API', () => {
  it('isolates workspaces, encrypts cookies/AI keys at rest, and handles sync/delete', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'litecourse-cloud-'));
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
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Public health endpoint
      const healthResp = await fetch(`${baseUrl}/health`);
      assert.equal(healthResp.status, 200);
      const health = (await healthResp.json()) as Record<string, unknown>;
      assert.equal(health.ok, true);
      assert.equal(health.semesterStartMonday, '2026-09-07');

      // 2. Reject invalid access code
      const unauth = await fetch(`${baseUrl}/api/status`, {
        headers: { 'X-Access-Code': 'wrong', 'X-User-Token': 'user_token_alpha_1' },
      });
      assert.equal(unauth.status, 401);

      // 3. Sync Workspace A with two accounts
      const syncA = await fetch(`${baseUrl}/api/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Code': config.accessCode,
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
              cookies: { sessionid: 'SECRET_COOKIE_ALPHA', csrftoken: 'csrf1' },
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
              cookies: 'UID=20002; _d=12345',
              timetable: [],
              reservations: [],
            },
          ],
        }),
      });
      assert.equal(syncA.status, 200);
      const syncAData = (await syncA.json()) as Record<string, unknown>;
      assert.equal(syncAData.syncedCount, 2);

      // Verify SQLite file does NOT store plaintext cookie or API key
      const rawDb = new DatabaseSync(path.join(tmpDir, 'cloud.db'));
      const rawRow = rawDb
        .prepare(
          'SELECT cookies_enc, ai_config_enc FROM accounts WHERE account_key = ?'
        )
        .get('rc:yuketang_10001') as { cookies_enc: string; ai_config_enc: string };
      rawDb.close();
      assert.ok(!rawRow.cookies_enc.includes('SECRET_COOKIE_ALPHA'));
      assert.ok(!rawRow.ai_config_enc.includes('sk-SECRET-API-KEY-ALPHA'));

      // 4. Workspace B cannot see Workspace A's accounts
      const statusB = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'X-Access-Code': config.accessCode,
          'X-User-Token': 'user_token_beta_2',
        },
      });
      const statusBData = (await statusB.json()) as { accounts: unknown[] };
      assert.equal(statusBData.accounts.length, 0);

      // 5. Delete one account from Workspace A
      const delResp = await fetch(
        `${baseUrl}/api/accounts/${encodeURIComponent('cx:20002')}`,
        {
          method: 'DELETE',
          headers: {
            'X-Access-Code': config.accessCode,
            'X-User-Token': 'user_token_alpha_1',
          },
        }
      );
      assert.equal(delResp.status, 200);
      const delData = (await delResp.json()) as { removed: boolean };
      assert.equal(delData.removed, true);

      const statusA = await fetch(`${baseUrl}/api/status`, {
        headers: {
          'X-Access-Code': config.accessCode,
          'X-User-Token': 'user_token_alpha_1',
        },
      });
      const statusAData = (await statusA.json()) as {
        accounts: Array<{ accountKey: string }>;
      };
      assert.equal(statusAData.accounts.length, 1);
      assert.equal(statusAData.accounts[0].accountKey, 'rc:yuketang_10001');
    } finally {
      scheduler.stop();
      rcEngine.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

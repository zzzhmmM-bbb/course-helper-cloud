import type { SignReservation, TimetableCourse } from './types.js';

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Utc8DateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  weekday: number; // 1..7 (Mon=1 .. Sun=7)
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  dateKey: string; // YYYY-MM-DD
  epochMs: number;
}

export interface SectionWatchWindow {
  defaultTriggerHour: number;
  defaultTriggerMinute: number;
  endHour: number;
  endMinute: number;
}

/**
 * ZCST 大节默认蹲守窗口：
 * - 1-2 节默认 07:58 起蹲守至 09:55（天然覆盖 8:00 与 8:10 两批错峰课）
 * - 3-4 节默认 10:08 起蹲守至 12:05（天然覆盖 10:10 与 10:20 错峰课）
 * - 5-6 节默认 13:58 起蹲守至 15:45
 * - 7-8 节默认 15:58 起蹲守至 17:45
 * - 9-10 节默认 18:58 起蹲守至 20:45
 * - 11-12 节默认 20:48 起蹲守至 22:35
 */
const SECTION_SLOTS: readonly {
  triggerHour: number;
  triggerMinute: number;
  endHour: number;
  endMinute: number;
}[] = [
  { triggerHour: 7, triggerMinute: 58, endHour: 8, endMinute: 58 }, // 1
  { triggerHour: 8, triggerMinute: 53, endHour: 9, endMinute: 55 }, // 2
  { triggerHour: 10, triggerMinute: 8, endHour: 11, endMinute: 8 }, // 3
  { triggerHour: 11, triggerMinute: 3, endHour: 12, endMinute: 5 }, // 4
  { triggerHour: 13, triggerMinute: 58, endHour: 14, endMinute: 50 }, // 5
  { triggerHour: 14, triggerMinute: 53, endHour: 15, endMinute: 45 }, // 6
  { triggerHour: 15, triggerMinute: 58, endHour: 16, endMinute: 50 }, // 7
  { triggerHour: 16, triggerMinute: 53, endHour: 17, endMinute: 45 }, // 8
  { triggerHour: 18, triggerMinute: 58, endHour: 19, endMinute: 50 }, // 9
  { triggerHour: 19, triggerMinute: 53, endHour: 20, endMinute: 45 }, // 10
  { triggerHour: 20, triggerMinute: 48, endHour: 21, endMinute: 40 }, // 11
  { triggerHour: 21, triggerMinute: 43, endHour: 22, endMinute: 35 }, // 12
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function getUtc8Parts(epochMs: number = Date.now()): Utc8DateParts {
  const shifted = new Date(epochMs + UTC8_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const jsDay = shifted.getUTCDay(); // 0=Sun..6=Sat
  const weekday = jsDay === 0 ? 7 : jsDay;
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    second,
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    epochMs,
  };
}

export function utc8EpochMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): number {
  return (
    Date.UTC(year, month - 1, day, hour, minute, second, 0) - UTC8_OFFSET_MS
  );
}

export function parseDateKeyUtc8Midnight(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateKey.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return utc8EpochMs(year, month, day, 0, 0, 0);
}

export function normalizeMondayUtc8(dateKey: string): number | null {
  const midnight = parseDateKeyUtc8Midnight(dateKey);
  if (midnight === null) return null;
  const parts = getUtc8Parts(midnight);
  return midnight - (parts.weekday - 1) * DAY_MS;
}

export function defaultSemesterStartMondayKey(
  nowMs: number = Date.now()
): string {
  const now = getUtc8Parts(nowMs);
  const approxYear = now.month >= 2 ? now.year : now.year - 1;
  const approxMonth = now.month >= 8 || now.month < 2 ? 9 : 3;
  const approxMidnight = utc8EpochMs(approxYear, approxMonth, 1, 0, 0, 0);
  const parts = getUtc8Parts(approxMidnight);
  const mondayMs = approxMidnight - (parts.weekday - 1) * DAY_MS;
  return getUtc8Parts(mondayMs).dateKey;
}

export function academicWeekForEpoch(
  semesterStartMondayKey: string,
  nowMs: number = Date.now()
): number {
  const startMonday =
    normalizeMondayUtc8(semesterStartMondayKey) ??
    normalizeMondayUtc8(defaultSemesterStartMondayKey(nowMs))!;
  const nowParts = getUtc8Parts(nowMs);
  const todayMidnight = utc8EpochMs(
    nowParts.year,
    nowParts.month,
    nowParts.day,
    0,
    0,
    0
  );
  const diffDays = Math.floor((todayMidnight - startMonday) / DAY_MS);
  const week = Math.floor(diffDays / 7) + 1;
  return Math.max(1, Math.min(20, week));
}

export function dateForWeekAndDay(
  semesterStartMondayKey: string,
  week: number,
  weekday: number
): Utc8DateParts {
  const startMonday =
    normalizeMondayUtc8(semesterStartMondayKey) ??
    normalizeMondayUtc8(defaultSemesterStartMondayKey())!;
  const offsetDays = (week - 1) * 7 + (weekday - 1);
  return getUtc8Parts(startMonday + offsetDays * DAY_MS);
}

export function defaultWatchWindowForCourse(
  course: Pick<TimetableCourse, 'startSection' | 'endSection'>
): SectionWatchWindow {
  const startIdx = Math.max(
    0,
    Math.min(SECTION_SLOTS.length - 1, (course.startSection || 1) - 1)
  );
  const endIdx = Math.max(
    startIdx,
    Math.min(SECTION_SLOTS.length - 1, (course.endSection || course.startSection || 1) - 1)
  );
  const startSlot = SECTION_SLOTS[startIdx];
  const endSlot = SECTION_SLOTS[endIdx];
  return {
    defaultTriggerHour: startSlot.triggerHour,
    defaultTriggerMinute: startSlot.triggerMinute,
    endHour: endSlot.endHour,
    endMinute: endSlot.endMinute,
  };
}

export function computeSlotEpochsUtc8(
  semesterStartMondayKey: string,
  course: TimetableCourse,
  reservation: SignReservation,
  week: number
): { triggerEpochMs: number; endEpochMs: number; dateKey: string } {
  const dayParts = dateForWeekAndDay(
    semesterStartMondayKey,
    week,
    course.weekday
  );
  const win = defaultWatchWindowForCourse(course);
  const triggerHour = reservation.useCustomTime
    ? reservation.customHour
    : win.defaultTriggerHour;
  const triggerMinute = reservation.useCustomTime
    ? reservation.customMinute
    : win.defaultTriggerMinute;

  const triggerEpochMs = utc8EpochMs(
    dayParts.year,
    dayParts.month,
    dayParts.day,
    triggerHour,
    triggerMinute,
    0
  );
  let endEpochMs = utc8EpochMs(
    dayParts.year,
    dayParts.month,
    dayParts.day,
    win.endHour,
    win.endMinute,
    0
  );
  if (endEpochMs <= triggerEpochMs) {
    // 自定义时间晚于常规下课时间时，至少留 45 分钟蹲守窗口
    endEpochMs = triggerEpochMs + 45 * 60 * 1000;
  }

  return {
    triggerEpochMs,
    endEpochMs,
    dateKey: dayParts.dateKey,
  };
}

export function formatUtc8Iso(epochMs: number = Date.now()): string {
  const p = getUtc8Parts(epochMs);
  return `${p.dateKey}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}+08:00`;
}

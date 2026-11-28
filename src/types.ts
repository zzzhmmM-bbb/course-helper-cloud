export type PlatformType = 'rainClassroom' | 'chaoxing';

export type RainClassroomServerType =
  | 'yuketang'
  | 'pro'
  | 'changjiang'
  | 'huanghe';

export type AccountSessionStatus = 'ok' | 'session_expired' | 'error';

export interface TimetableCourse {
  id: string;
  name: string;
  teacher: string;
  classroom: string;
  weekday: number; // 1..7 (Mon..Sun)
  startSection: number; // 1..12
  endSection: number; // 1..12
  weeks: number[]; // e.g. [1,2,3,...]
  colorIndex?: number;
}

export interface SignReservation {
  id: string;
  timetableCourseId: string;
  courseName: string;
  /** null means whole semester; integer means only that specific week */
  targetWeek: number | null;
  enabled: boolean;
  useCustomTime: boolean;
  customHour: number;
  customMinute: number;
  boundOnlineCourseId?: string | null;
  boundOnlineClassId?: string | null;
  boundOnlineCpi?: string | null;
  boundOnlineCourseName?: string | null;
  /** Always defaults to true in foolproof cloud mode */
  silentLocationSignIn?: boolean;
  signedDates?: Record<string, string>;
}

export interface CourseLocationPreset {
  address: string;
  latitude: number;
  longitude: number;
  /** 'gcj02' (default for RC) or 'bd09' (default for CX) */
  coordType?: 'gcj02' | 'bd09';
}

export interface AiConfig {
  enabled: boolean;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  autoSubmitSubjective: boolean;
  autoRetryExpired: boolean;
}

export interface AccountDeviceInfo {
  cid?: string;
  sc?: string;
  [key: string]: unknown;
}

export interface AccountConfigPayload {
  semesterStartMonday?: string | null;
  timetable: TimetableCourse[];
  reservations: SignReservation[];
  courseLocations?: Record<string, CourseLocationPreset>;
  aiConfig?: AiConfig | null;
}

export interface BoundDeviceInfo {
  deviceId: string;
  deviceName: string;
  platformOs: string;
  isTablet: boolean;
  boundAt: string;
  lastSeenAt: string;
  lastSeenMs: number;
  isCurrentDevice?: boolean;
}

export interface AccountSyncItem {
  /** Composite isolated key: e.g. rc:yuketang_123456 or cx:987654 */
  accountKey: string;
  platform: PlatformType;
  /** RainClassroom server type; ignored for chaoxing */
  server?: RainClassroomServerType;
  /** Raw numeric platform user id (CRITICAL: RC x-uid & WS hello userid) */
  uid: string;
  name: string;
  /** Full cookie header string or serialized cookie map */
  cookies: Record<string, string> | string;
  cookiesUpdatedAt?: number;
  deviceInfo?: AccountDeviceInfo | null;
  semesterStartMonday?: string | null;
  timetable: TimetableCourse[];
  reservations: SignReservation[];
  courseLocations?: Record<string, CourseLocationPreset>;
  aiConfig?: AiConfig | null;
}

export interface CloudSyncRequest {
  accounts: AccountSyncItem[];
  deviceName?: string;
  platformOs?: string;
  isTablet?: boolean;
}

export interface PullAccountInput {
  accountKey: string;
  platform: PlatformType;
  server?: RainClassroomServerType;
  uid: string;
  name: string;
  knownRev?: number;
  cookies?: Record<string, string> | string;
  cookiesUpdatedAt?: number;
  deviceInfo?: AccountDeviceInfo | null;
  /** Only used to seed cloud when this accountKey does NOT exist yet */
  initialConfig?: AccountConfigPayload | null;
}

export interface PullSyncRequest {
  deviceName?: string;
  platformOs?: string;
  isTablet?: boolean;
  logLimit?: number;
  accounts: PullAccountInput[];
}

export interface PushAccountConfigRequest {
  deviceName?: string;
  platformOs?: string;
  isTablet?: boolean;
  platform: PlatformType;
  server?: RainClassroomServerType;
  uid: string;
  name: string;
  baseRev?: number;
  cookies?: Record<string, string> | string;
  cookiesUpdatedAt?: number;
  deviceInfo?: AccountDeviceInfo | null;
  semesterStartMonday?: string | null;
  timetable: TimetableCourse[];
  reservations: SignReservation[];
  courseLocations?: Record<string, CourseLocationPreset>;
  aiConfig?: AiConfig | null;
  allowClearApiKey?: boolean;
}

export interface StoredAccount {
  accountKey: string;
  platform: PlatformType;
  server: RainClassroomServerType;
  uid: string;
  name: string;
  cookies: Record<string, string>;
  cookiesUpdatedAt: number;
  deviceInfo: AccountDeviceInfo;
  semesterStartMonday: string | null;
  timetable: TimetableCourse[];
  reservations: SignReservation[];
  courseLocations: Record<string, CourseLocationPreset>;
  aiConfig: AiConfig | null;
  configRev: number;
  configUpdatedAt: string;
  lastEditorDeviceId: string;
  sessionStatus: AccountSessionStatus;
  sessionError: string;
  updatedAt: string;
}

export type LogCategory =
  | 'sync'
  | 'checkin'
  | 'reopen_checkin'
  | 'location'
  | 'ai_answer'
  | 'session'
  | 'system';

export interface RcLessonGuardLocation {
  address: string;
  latitude: number;
  longitude: number;
}

export interface RcLessonGuardRecord {
  accountKey: string;
  guardKey: string;
  courseId: string;
  classroomId: string;
  courseTitle: string;
  classroom: string;
  signedLessonIds: string[];
  reopenCount: number;
  lastLocation: RcLessonGuardLocation | null;
  expireAtMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRcLessonGuardRequest {
  lessonId: string;
  courseId?: string | null;
  classroomId?: string | null;
  courseTitle?: string | null;
  classroom?: string | null;
  expireAtMs?: number | null;
  lastLocation?: RcLessonGuardLocation | null;
}

export type LogSeverity = 'info' | 'success' | 'warn' | 'error';

export interface ExecutionLogItem {
  id: number;
  accountKey: string;
  accountName: string;
  platform: PlatformType | 'system';
  category: LogCategory;
  level: LogSeverity;
  title: string;
  detail: string;
  courseName: string;
  lessonId: string;
  problemId: string;
  createdAt: string;
}

export interface ActiveSessionSnapshot {
  sessionKey: string;
  accountKey: string;
  accountName: string;
  lessonId: string;
  courseId: string;
  courseTitle: string;
  isConnected: boolean;
  paused: boolean;
  isFinished: boolean;
  currentSlideIndex: number;
  solvedCount: number;
  pendingCount: number;
  startedAt: string;
  lastActivityAt: string;
}

export interface OwnershipVerifyResult {
  ok: boolean;
  expired?: boolean;
  actualUid?: string;
  reason?: string;
}

export interface OnlineCourse {
  courseId: string;
  classId: string;
  name: string;
  teacher: string;
  cpi?: string;
  lessonId?: string;
}

export interface ProblemOption {
  key: string;
  value: string;
}

export interface ProblemBlank {
  num: number;
  score: number;
  answers: string[];
}

export interface ProblemData {
  problemId: string;
  problemType: number;
  body: string;
  score: number;
  remark: string;
  options: ProblemOption[];
  pollingCount?: number;
  dt?: number;
  blanks: ProblemBlank[];
}

export interface SlideShape {
  text?: string;
}

export interface PresentationSlide {
  id: string;
  index: number;
  cover: string;
  coverAlt: string;
  thumbnail: string;
  shapes: SlideShape[];
  note: string;
  problem?: ProblemData;
}

export interface PresentationData {
  title: string;
  width: number;
  height: number;
  version: string;
  slides: PresentationSlide[];
}

export function rcServerHost(server: RainClassroomServerType): string {
  switch (server) {
    case 'pro':
      return 'pro.yuketang.cn';
    case 'changjiang':
      return 'changjiang.yuketang.cn';
    case 'huanghe':
      return 'huanghe.yuketang.cn';
    case 'yuketang':
    default:
      return 'www.yuketang.cn';
  }
}

export function rcServerBaseUrl(server: RainClassroomServerType): string {
  return `https://${rcServerHost(server)}`;
}

export function rcServerWsUrl(server: RainClassroomServerType): string {
  return `wss://${rcServerHost(server)}/wsapp/`;
}

export function normalizeCourseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s()（）【】[\]·\-—_ⅠⅡⅢⅣⅤiv]+/g, '');
}

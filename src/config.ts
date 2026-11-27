import path from 'node:path';
import crypto from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  port: number;
  host: string;
  accessCode: string;
  encryptionKey: string;
  dataDir: string;
  semesterStartMonday: string;
  logLevel: LogLevel;
  pollIntervalMs: number;
  maxLogsPerWorkspace: number;
}

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function parseLogLevel(raw?: string): LogLevel {
  const normalized = (raw ?? 'info').trim().toLowerCase();
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
  ) {
    return normalized;
  }
  return 'info';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number.parseInt(env.PORT ?? '8787', 10) || 8787;
  const host = (env.HOST ?? '0.0.0.0').trim() || '0.0.0.0';
  const dataDir = path.resolve((env.DATA_DIR ?? './data').trim() || './data');

  let accessCode = (env.ACCESS_CODE ?? '').trim();
  if (!accessCode) {
    accessCode = 'dev-access-code';
    console.warn(
      '[WARN] ACCESS_CODE is not set; using insecure fallback "dev-access-code". Set ACCESS_CODE in production!'
    );
  }

  let encryptionKey = (env.ENCRYPTION_KEY ?? '').trim();
  if (!encryptionKey) {
    encryptionKey = crypto
      .createHash('sha256')
      .update(`fallback-key:${accessCode}:${dataDir}`)
      .digest('hex');
    console.warn(
      '[WARN] ENCRYPTION_KEY is not set; deriving fallback key. Set a fixed ENCRYPTION_KEY in production!'
    );
  }

  const semesterStartMonday =
    (env.SEMESTER_START_MONDAY ?? '2026-09-07').trim() || '2026-09-07';

  return {
    port,
    host,
    accessCode,
    encryptionKey,
    dataDir,
    semesterStartMonday,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    pollIntervalMs: Math.max(
      5000,
      Number.parseInt(env.POLL_INTERVAL_MS ?? '15000', 10) || 15000
    ),
    maxLogsPerWorkspace: Math.max(
      50,
      Number.parseInt(env.MAX_LOGS_PER_WORKSPACE ?? '300', 10) || 300
    ),
  };
}

export class Logger {
  constructor(private readonly level: LogLevel = 'info') {}

  private shouldLog(target: LogLevel): boolean {
    return LOG_PRIORITY[target] >= LOG_PRIORITY[this.level];
  }

  private format(target: LogLevel, scope: string, message: string): string {
    const ts = new Date().toISOString();
    return `[${ts}] [${target.toUpperCase()}] [${scope}] ${message}`;
  }

  debug(scope: string, message: string): void {
    if (this.shouldLog('debug')) {
      console.debug(this.format('debug', scope, message));
    }
  }

  info(scope: string, message: string): void {
    if (this.shouldLog('info')) {
      console.info(this.format('info', scope, message));
    }
  }

  warn(scope: string, message: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.format('warn', scope, message));
    }
  }

  error(scope: string, message: string): void {
    if (this.shouldLog('error')) {
      console.error(this.format('error', scope, message));
    }
  }
}

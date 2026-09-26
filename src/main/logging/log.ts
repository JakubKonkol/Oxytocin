import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import electronLog from 'electron-log/main';
import { formatLogArgs, type LogLevel, type Logger, type LogRecord } from '@shared/logging/logger';

const MAX_LOG_SIZE = 5 * 1024 * 1024;
const KEEP_ROTATED = 2; // main.log + main.1.log + main.2.log

let initialized = false;

/** Configures electron-log: userData/logs/main.log, 5 MB × 3 rotation. Call once after userData is final. */
export function initLogging(level: LogLevel = 'info'): void {
  if (initialized) return;
  initialized = true;
  const envLevel = process.env['OXYTOCIN_LOG'];
  const effective: LogLevel =
    envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error' ? envLevel : level;
  electronLog.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log');
  electronLog.transports.file.maxSize = MAX_LOG_SIZE;
  electronLog.transports.file.level = effective;
  electronLog.transports.console.level = app.isPackaged ? false : effective;
  electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  electronLog.transports.file.archiveLogFn = (oldFile) => {
    const file = oldFile.path;
    const base = file.replace(/\.log$/, '');
    for (let i = KEEP_ROTATED; i >= 1; i--) {
      const src = i === 1 ? file : `${base}.${i - 1}.log`;
      const dst = `${base}.${i}.log`;
      try {
        if (i === KEEP_ROTATED && existsSync(dst)) rmSync(dst);
        if (existsSync(src)) renameSync(src, dst);
      } catch {
        // Rotation is best-effort; logging must never crash the app.
      }
    }
  };
  electronLog.errorHandler.startCatching({ showDialog: false });
}

export function setLogLevel(level: LogLevel): void {
  electronLog.transports.file.level = level;
  if (!app.isPackaged) electronLog.transports.console.level = level;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  return {
    error: (message, ...args) => electronLog.error(prefix, formatLogArgs(message, args)),
    warn: (message, ...args) => electronLog.warn(prefix, formatLogArgs(message, args)),
    info: (message, ...args) => electronLog.info(prefix, formatLogArgs(message, args)),
    debug: (message, ...args) => electronLog.debug(prefix, formatLogArgs(message, args)),
  };
}

/** Writes a record forwarded from a utility host (scope prefix like [pty], [ws], [plg:<id>]). */
export function writeForwardedLog(record: LogRecord): void {
  electronLog[record.level](`[${record.scope}]`, record.message);
}

export function logFilePath(): string {
  return electronLog.transports.file.getFile().path;
}

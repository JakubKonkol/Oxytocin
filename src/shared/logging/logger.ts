export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
}

export function formatLogArgs(message: string, args: readonly unknown[]): string {
  if (args.length === 0) return message;
  const rest = args.map((a) => {
    if (a instanceof Error) return a.stack ?? a.message;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return [message, ...rest].join(' ');
}

/** A logger that turns every call into a LogRecord (used by utility hosts to forward logs to main). */
export function createForwardingLogger(scope: string, sink: (record: LogRecord) => void): Logger {
  const make =
    (level: LogLevel) =>
    (message: string, ...args: unknown[]) =>
      sink({ level, scope, message: formatLogArgs(message, args) });
  return { error: make('error'), warn: make('warn'), info: make('info'), debug: make('debug') };
}

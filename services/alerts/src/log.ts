/** One-line JSON logs (docs/alerts.md §3.1). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  alertId?: string;
  series?: string;
  [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, f?: LogFields): void;
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
}

export function isLogLevel(v: string): v is LogLevel {
  return v in ORDER;
}

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Logger {
  const min = ORDER[level];
  const emit = (lv: LogLevel, msg: string, f?: LogFields) => {
    if (ORDER[lv] < min) return;
    write(JSON.stringify({ level: lv, msg, ...f }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = createLogger('error', () => {});

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

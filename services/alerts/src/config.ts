/** Env parsing (docs/alerts.md §4.1). Invalid values are a startup error. */
import { isLogLevel, type LogLevel } from './log';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  apiUrl: string;
  wsUrl: string;
  token: string | null;
  pollMs: number;
  closeGraceS: number;
  minRefireS: number;
  stateFlushMs: number;
  maxBars: number;
  maxDrawingBars: number;
  logLevel: LogLevel;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer in ${min}..${max}, got '${raw}'`);
  return n;
}

export function deriveWsUrl(apiUrl: string): string {
  const u = new URL(apiUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function loadConfig(env: Env = process.env): Config {
  const rawUrl = (env['API_URL'] ?? 'http://localhost:8000').trim();
  let wsUrl: string;
  try {
    wsUrl = deriveWsUrl(rawUrl);
  } catch {
    throw new ConfigError(`API_URL is not a valid URL: '${rawUrl}'`);
  }
  const level = (env['ALERTS_LOG_LEVEL'] ?? 'info').trim().toLowerCase();
  if (!isLogLevel(level))
    throw new ConfigError(`ALERTS_LOG_LEVEL must be debug|info|warn|error, got '${level}'`);
  const token = env['ALERTS_INTERNAL_TOKEN']?.trim();
  return {
    apiUrl: rawUrl.replace(/\/+$/, ''),
    wsUrl,
    token: token ? token : null,
    pollMs: int(env, 'ALERTS_POLL_MS', 30_000, 1000),
    closeGraceS: int(env, 'ALERTS_CLOSE_GRACE_S', 60, 0),
    minRefireS: int(env, 'ALERTS_MIN_REFIRE_S', 60, 0),
    stateFlushMs: int(env, 'ALERTS_STATE_FLUSH_MS', 5000, 100),
    maxBars: int(env, 'ALERTS_MAX_BARS', 5000, 50, 100_000),
    maxDrawingBars: int(env, 'ALERTS_MAX_DRAWING_BARS', 20_000, 50, 100_000),
    logLevel: level,
  };
}

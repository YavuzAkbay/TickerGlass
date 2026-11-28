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
  /**
   * Hard limit of a shutdown (drain fires, flush state), ms; the process exits when it passes.
   * The default stays under Docker's 10 s stop grace period (SIGKILL after it); raise both together.
   */
  shutdownMs: number;
  maxBars: number;
  maxDrawingBars: number;
  /** Heap limit of each user-script isolate, MB. */
  scriptMemoryMb: number;
  /** Time limit of a script's load, first compute and Check, ms. */
  scriptLoadMs: number;
  /** Time limit of one live update of a script, ms. */
  scriptTickMs: number;
  /** Share of one CPU (%) a script isolate may use over 5 minutes before it is held off. */
  scriptCpuPct: number;
  /** Share of one CPU (%) all script isolates together may use over 5 minutes. */
  scriptCpuTotalPct: number;
  /** Resident memory cap of the script child process, MB. */
  scriptProcessMb: number;
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
    // The token is never part of the URL (access logs): sockets send it as an X-Alerts-Token
    // header on the handshake, see ws-auth.ts.
    wsUrl,
    token: token ? token : null,
    pollMs: int(env, 'ALERTS_POLL_MS', 30_000, 1000),
    closeGraceS: int(env, 'ALERTS_CLOSE_GRACE_S', 60, 0),
    minRefireS: int(env, 'ALERTS_MIN_REFIRE_S', 60, 0),
    stateFlushMs: int(env, 'ALERTS_STATE_FLUSH_MS', 5000, 100),
    shutdownMs: int(env, 'ALERTS_SHUTDOWN_MS', 8000, 3000, 120_000),
    maxBars: int(env, 'ALERTS_MAX_BARS', 5000, 50, 100_000),
    maxDrawingBars: int(env, 'ALERTS_MAX_DRAWING_BARS', 20_000, 50, 100_000),
    scriptMemoryMb: int(env, 'ALERTS_SCRIPT_MEMORY_MB', 128, 8, 4096),
    scriptLoadMs: int(env, 'ALERTS_SCRIPT_LOAD_MS', 10_000, 50, 600_000),
    scriptTickMs: int(env, 'ALERTS_SCRIPT_TICK_MS', 250, 10, 60_000),
    scriptCpuPct: int(env, 'ALERTS_SCRIPT_CPU_PCT', 20, 1, 100),
    scriptCpuTotalPct: int(env, 'ALERTS_SCRIPT_CPU_TOTAL_PCT', 50, 1, 100),
    scriptProcessMb: int(env, 'ALERTS_SCRIPT_PROCESS_MB', 768, 128, 65_536),
    logLevel: level,
  };
}

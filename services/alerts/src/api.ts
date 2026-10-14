/** Typed REST client for the data API (docs/alerts.md §3.1). */
import type {
  Alert,
  FireIn,
  ServiceHeartbeat,
  AlertLogEntry,
  AlertRuntimeState,
} from '@investopen/alerts';

/** HTTP failure. `status` 0 = network error. 409 carries `current`. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly current: Alert | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Worth retrying: network error or 5xx. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface StoredDrawing {
  id: string;
  symbol: string | null;
  data: {
    id?: string;
    type: string;
    points: { time: number; price: number }[];
    style: Record<string, unknown>;
    scope?: string;
    symbol?: string;
  };
}

export interface StateRow {
  alertId: string;
  revision: number;
  state: AlertRuntimeState;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: typeof fetch;
  /** Attempts per call for transient failures (default 3). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Request timeout, ms (default 15 s). */
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ApiClient {
  private readonly base: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl;
    this.attempts = opts.attempts ?? 3;
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async once(
    method: string,
    path: string,
    body: unknown,
    service: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (service && this.token) headers['X-Alerts-Token'] = this.token;
    const f = this.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await f(`${this.base}${path}`, init);
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : 'network error', 0);
    }
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return json;
    const detail = (json as { detail?: unknown } | null)?.detail;
    let message = `HTTP ${res.status}`;
    let current: Alert | null = null;
    if (typeof detail === 'string') message = detail;
    else if (detail && typeof detail === 'object') {
      const d = detail as { message?: unknown; current?: unknown };
      if (typeof d.message === 'string') message = d.message;
      if (d.current && typeof d.current === 'object') current = d.current as Alert;
    }
    throw new ApiError(message, res.status, current);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    service = false,
  ): Promise<T> {
    let last: ApiError | null = null;
    for (let i = 0; i < this.attempts; i++) {
      try {
        return (await this.once(method, path, body, service)) as T;
      } catch (err) {
        if (!(err instanceof ApiError) || !err.transient) throw err;
        last = err;
        if (i < this.attempts - 1) await this.sleep(Math.min(8000, 500 * 2 ** i));
      }
    }
    throw last ?? new ApiError('request failed', 0);
  }

  health(): Promise<unknown> {
    return this.request('GET', '/api/health');
  }
  listAlerts(): Promise<Alert[]> {
    return this.request('GET', '/api/alerts');
  }
  getAlert(id: string): Promise<Alert> {
    return this.request('GET', `/api/alerts/${encodeURIComponent(id)}`);
  }
  listStates(): Promise<StateRow[]> {
    return this.request('GET', '/api/alerts/states');
  }
  putStates(states: StateRow[]): Promise<{ written: string[]; ignored: string[] }> {
    return this.request('PUT', '/api/alerts/states', { states }, true);
  }
  fire(id: string, body: FireIn): Promise<AlertLogEntry> {
    return this.request('POST', `/api/alerts/${encodeURIComponent(id)}/fire`, body, true);
  }
  setStatus(
    id: string,
    body: { revision: number; status: 'expired' | 'error'; reason: string },
  ): Promise<Alert> {
    return this.request('POST', `/api/alerts/${encodeURIComponent(id)}/status`, body, true);
  }
  async heartbeat(hb: ServiceHeartbeat): Promise<void> {
    await this.request('POST', '/api/alerts/service/heartbeat', hb, true);
  }
  /** Drawings of a symbol (plus synced ones); all drawings when `symbol` is null or too long. */
  async getDrawings(symbol: string | null): Promise<StoredDrawing[]> {
    const q = symbol !== null && symbol.length <= 32 ? `?symbol=${encodeURIComponent(symbol)}` : '';
    const res = await this.request<{ drawings: StoredDrawing[] }>('GET', `/api/drawings${q}`);
    return res.drawings;
  }
}

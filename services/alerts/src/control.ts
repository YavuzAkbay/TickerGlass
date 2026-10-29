/** Control /ws: event topics `alerts` and `drawings` (docs/alerts.md §1.6, §3.1). */
import type { Logger } from './log';
import { backoffMs, jitter } from './clock';

export interface ControlLike {
  start(): void;
  stop(): void;
  readonly connected: boolean;
  onAlertsChanged(fn: (ids: string[], deleted: string[]) => void): void;
  onDrawingsChanged(fn: (ids: string[], deleted: string[]) => void): void;
  /** Connection up/down (registry polls every 10 s while down). */
  onConnection(fn: (connected: boolean) => void): void;
  /** The API switched its data provider: bars and symbol data changed under every series. */
  onProviderChanged(fn: () => void): void;
}

const PING_MS = 25_000;
/** No frame (pong included) for this long = the socket is dead. */
const DEAD_MS = 2 * PING_MS;

export class ControlSocket implements ControlLike {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private up = false;
  private readonly alertsFns: ((ids: string[], deleted: string[]) => void)[] = [];
  private readonly drawingsFns: ((ids: string[], deleted: string[]) => void)[] = [];
  private readonly connFns: ((c: boolean) => void)[] = [];
  private readonly providerFns: (() => void)[] = [];

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly WS: typeof WebSocket | undefined = undefined,
  ) {}

  get connected(): boolean {
    return this.up;
  }
  onAlertsChanged(fn: (ids: string[], deleted: string[]) => void): void {
    this.alertsFns.push(fn);
  }
  onDrawingsChanged(fn: (ids: string[], deleted: string[]) => void): void {
    this.drawingsFns.push(fn);
  }
  onConnection(fn: (c: boolean) => void): void {
    this.connFns.push(fn);
  }

  onProviderChanged(fn: () => void): void {
    this.providerFns.push(fn);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = null;
    this.cleanup();
    this.ws?.close();
    this.ws = null;
    this.setUp(false);
  }

  private setUp(v: boolean): void {
    if (this.up === v) return;
    this.up = v;
    for (const f of this.connFns) f(v);
  }

  private cleanup(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  private connect(): void {
    const Impl = this.WS ?? globalThis.WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.url);
    } catch (err) {
      this.log.warn('control socket failed to open', { error: String(err) });
      this.schedule();
      return;
    }
    this.ws = ws;
    let lastRx = Date.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      lastRx = Date.now();
      ws.send(JSON.stringify({ op: 'events', topics: ['alerts', 'drawings'] }));
      this.ping = setInterval(() => {
        if (this.ws !== ws) return;
        if (Date.now() - lastRx >= DEAD_MS) {
          this.log.warn('control socket silent, reconnecting');
          try {
            ws.close();
          } catch {
            /* already closed */
          }
          lost();
          return;
        }
        if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' }));
      }, PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      lastRx = Date.now();
      this.handle(ev.data);
    };
    const lost = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.cleanup();
      this.setUp(false);
      if (!this.stopped) this.schedule();
    };
    ws.onclose = lost;
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      lost();
    };
  }

  private schedule(): void {
    if (this.stopped || this.reconnect) return;
    const ms = jitter(backoffMs(this.attempt++, 1000, 30_000));
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      if (!this.stopped) this.connect();
    }, ms);
  }

  private handle(data: unknown): void {
    if (typeof data !== 'string') return;
    let f: unknown;
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof f !== 'object' || f === null) return;
    const m = f as { type?: unknown; ids?: unknown; deleted?: unknown; message?: unknown };
    const strs = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    switch (m.type) {
      case 'events':
        this.setUp(true);
        break;
      case 'alerts.changed':
        for (const fn of this.alertsFns) fn(strs(m.ids), strs(m.deleted));
        break;
      case 'drawings.changed':
        for (const fn of this.drawingsFns) fn(strs(m.ids), strs(m.deleted));
        break;
      case 'provider.changed':
        for (const fn of this.providerFns) fn();
        break;
      case 'error':
        this.log.warn('control socket error frame', { message: String(m.message) });
        break;
      default:
        break;
    }
  }
}

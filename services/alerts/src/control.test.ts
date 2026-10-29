import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlSocket } from './control';
import { silentLogger } from './log';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  frame(o: unknown): void {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.all = [];
});
afterEach(() => vi.useRealTimers());

function open() {
  const c = new ControlSocket('ws://x', silentLogger, FakeWS as unknown as typeof WebSocket);
  const ups: boolean[] = [];
  c.onConnection((u) => ups.push(u));
  c.start();
  const ws = FakeWS.all[0]!;
  ws.onopen?.();
  ws.frame({ type: 'events' });
  return { c, ws, ups };
}

describe('control socket liveness', () => {
  it('treats a socket with no frame for 2x the ping interval as lost and reconnects', async () => {
    const { c, ws, ups } = open();
    expect(c.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ws.sent.some((m) => m.includes('ping'))).toBe(true);
    expect(c.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(ws.closed).toBe(true);
    expect(c.connected).toBe(false);
    expect(ups).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWS.all).toHaveLength(2);
    c.stop();
  });

  it('a pong keeps the socket alive', async () => {
    const { c, ws } = open();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      ws.frame({ type: 'pong' });
    }
    expect(c.connected).toBe(true);
    expect(ws.closed).toBe(false);
    c.stop();
  });
});

describe('control socket provider.changed', () => {
  it('calls every provider-changed listener once per frame and ignores other frames', () => {
    const c = new ControlSocket('ws://x', silentLogger, FakeWS as unknown as typeof WebSocket);
    const a: number[] = [];
    const b: number[] = [];
    c.onProviderChanged(() => a.push(1));
    c.onProviderChanged(() => b.push(1));
    c.start();
    const ws = FakeWS.all[0]!;
    ws.onopen?.();
    ws.frame({ type: 'events' });
    ws.frame({ type: 'provider.changed', id: 'twelvedata', previous: 'yahoo' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    ws.frame({ type: 'alerts.changed', ids: ['a'], deleted: [] });
    ws.frame({ type: 'provider.changed' }); // no payload is needed
    expect(a).toHaveLength(2);
    c.stop();
  });
});

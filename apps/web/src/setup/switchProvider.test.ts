import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJsonCache } from '../api/client';
import { FULL_CAPABILITIES, type ProviderInfo } from '../api/provider';
import { SETUP_KEY, markSetupDone } from './firstRun';
import {
  chooseProvider,
  isSwitchingHere,
  resetSwitchingHere,
  switchMessage,
} from './switchProvider';

const h = vi.hoisted(() => ({
  toasts: [] as { message: string; kind: string | undefined }[],
  order: [] as string[],
}));
vi.mock('../ui/Toast', () => ({
  toast: (message: string, kind?: string) => h.toasts.push({ message, kind }),
}));
vi.mock('../ui/Prompt', () => ({ confirmDialog: vi.fn(() => Promise.resolve(false)) }));
vi.mock('../persist/bootstrap', () => ({
  getPersistence: () => ({
    flushAll: () => {
      h.order.push('flush');
      return Promise.resolve();
    },
  }),
}));

const target = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'twelvedata',
  name: 'Twelve Data',
  description: '',
  network: true,
  terms: null,
  configured: true,
  capabilities: FULL_CAPABILITIES,
  costs: {
    history: 1,
    symbolInfo: 1,
    search: 1,
    quoteBatch: 1,
    quotePerRequest: 0,
    quotePerSymbol: 1,
    events: 1,
    news: 1,
    fundamentals: 1,
  },
  budget: { ratePerMin: 8, burst: 8, daily: 800 },
  config: [],
  plan: 'basic',
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let posts: { url: string; body: unknown }[] = [];
let gets: string[] = [];
const store = new Map<string, string>();
let respond: () => Response;
let respondGet: () => Response;
let reloads = 0;
const reload = () => {
  h.order.push('reload');
  reloads++;
};
const yes = vi.fn(() => Promise.resolve(true));
const no = vi.fn(() => Promise.resolve(false));

beforeEach(() => {
  h.toasts.length = 0;
  h.order.length = 0;
  posts = [];
  gets = [];
  reloads = 0;
  yes.mockClear();
  no.mockClear();
  respond = () => json({ active: 'twelvedata' });
  respondGet = () => json({ active: 'yahoo' });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') {
      gets.push(url);
      return Promise.resolve(respondGet());
    }
    posts.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    return Promise.resolve(respond());
  });
  clearJsonCache();
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  resetSwitchingHere();
});
afterEach(() => vi.unstubAllGlobals());

describe('switchMessage', () => {
  it('names the cache clearing and reload, and the plan credits only with a daily cap', () => {
    const metered = switchMessage(target());
    expect(metered).toContain('Cached market data will be cleared and reloaded from Twelve Data.');
    expect(metered).toContain('The page will reload.');
    expect(metered).toContain('Reloading charts and quotes uses credits of your basic plan.');
    const free = switchMessage(target({ budget: { ratePerMin: 60, burst: 60, daily: null } }));
    expect(free).not.toContain('credits');
  });
});

describe('chooseProvider', () => {
  it('does nothing when the confirmation is cancelled', async () => {
    expect(await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: no })).toBe(
      false,
    );
    expect(posts).toEqual([]);
    expect(reloads).toBe(0);
    expect(isSwitchingHere()).toBe(false);
  });

  it('asks with the credit note, POSTs, flushes, then reloads', async () => {
    const ok = await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes });
    expect(ok).toBe(true);
    const asked = yes.mock.calls[0] as unknown as [{ message: string }];
    expect(asked[0].message).toContain('uses credits of your basic plan');
    expect(posts).toEqual([{ url: '/api/providers/active', body: { id: 'twelvedata' } }]);
    expect(h.order).toEqual(['flush', 'reload']);
    expect(isSwitchingHere()).toBe(true); // this page is going away
    expect(h.toasts).toEqual([]);
  });

  it('shows the server detail and does not reload on 403 or 409', async () => {
    for (const [status, detail] of [
      [403, 'Switching is disabled'],
      [409, 'Twelve Data is not configured: set TWELVEDATA_API_KEY and restart the API'],
    ] as const) {
      h.toasts.length = 0;
      respond = () => json({ detail, code: 'x' }, status);
      const ok = await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes });
      expect(ok).toBe(false);
      expect(h.toasts).toEqual([{ message: detail, kind: 'error' }]);
      expect(isSwitchingHere()).toBe(false);
    }
    expect(reloads).toBe(0);
    expect(h.order).toEqual([]);
  });

  it('treats a failed request as done when the API switched anyway', async () => {
    respond = () => json({ detail: 'timeout' }, 504);
    respondGet = () => json({ active: 'twelvedata' });
    const ok = await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes });
    expect(ok).toBe(true);
    expect(gets).toEqual(['/api/providers']);
    expect(h.order).toEqual(['flush', 'reload']);
    expect(h.toasts).toEqual([]);
    expect(isSwitchingHere()).toBe(true);
  });

  it('re-checks past the providers cache and toasts when the provider did not change', async () => {
    // A cached answer from before the request must not be believed.
    const { getProviders } = await import('../api/provider');
    respondGet = () => json({ active: 'twelvedata' });
    await getProviders();
    respondGet = () => json({ active: 'yahoo' });
    respond = () => json({ detail: 'Twelve Data is not configured' }, 409);
    const ok = await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes });
    expect(ok).toBe(false);
    expect(gets).toHaveLength(2); // the cached read, then a fresh one
    expect(reloads).toBe(0);
    expect(h.toasts).toEqual([{ message: 'Twelve Data is not configured', kind: 'error' }]);
    expect(isSwitchingHere()).toBe(false);
  });

  it('toasts the original error when the re-check fails too', async () => {
    respond = () => json({ detail: 'API down' }, 503);
    respondGet = () => json({ detail: 'API down' }, 503);
    const ok = await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes });
    expect(ok).toBe(false);
    expect(reloads).toBe(0);
    expect(h.toasts).toEqual([{ message: 'API down', kind: 'error' }]);
  });

  it('runs beforeSwitch after the confirmation, before the request and the flush', async () => {
    const beforeSwitch = vi.fn(() => {
      h.order.push(`before(posts=${posts.length}, confirms=${yes.mock.calls.length})`);
    });
    await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: yes, beforeSwitch });
    expect(h.order).toEqual(['before(posts=0, confirms=1)', 'flush', 'reload']);
    expect(posts).toHaveLength(1);
  });

  it('does not run beforeSwitch when the confirmation is cancelled', async () => {
    const beforeSwitch = vi.fn();
    await chooseProvider(target(), { active: 'yahoo' }, { reload, confirm: no, beforeSwitch });
    expect(beforeSwitch).not.toHaveBeenCalled();
  });

  it('a failing beforeSwitch cancels the switch with a toast', async () => {
    const beforeSwitch = vi.fn(() => Promise.reject(new Error('could not revert')));
    const ok = await chooseProvider(
      target(),
      { active: 'yahoo' },
      { reload, confirm: yes, beforeSwitch },
    );
    expect(ok).toBe(false);
    expect(posts).toEqual([]);
    expect(reloads).toBe(0);
    expect(h.toasts).toEqual([{ message: 'could not revert', kind: 'error' }]);
    expect(isSwitchingHere()).toBe(false);
  });

  it('marking the first-run step done as beforeSwitch is stored before the request', async () => {
    let storedAtPost: string | null = 'unset';
    respond = () => {
      storedAtPost = store.get(SETUP_KEY) ?? null;
      return json({ active: 'twelvedata' });
    };
    await chooseProvider(
      target(),
      { active: 'yahoo' },
      { reload, confirm: yes, beforeSwitch: markSetupDone },
    );
    expect(storedAtPost).toBe('1');
  });

  it('ignores the provider already in use', async () => {
    expect(await chooseProvider(target(), { active: 'twelvedata' }, { reload, confirm: yes })).toBe(
      false,
    );
    expect(yes).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
  });
});

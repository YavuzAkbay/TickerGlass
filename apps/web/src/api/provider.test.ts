import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, clearJsonCache, isNotConfigured, isRetryable, isUnsupported } from './client';
import { classifyChartError } from '../chart/errorState';
import {
  FULL_CAPABILITIES,
  USAGE_POLL_MS,
  getCapabilities,
  loadProvider,
  resetProviderStore,
  setActiveProvider,
  useProviderStore,
  useUsageStore,
  watchUsage,
  type ProvidersResponse,
  type Usage,
} from './provider';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let calls: string[] = [];
let respond: (url: string) => Response;

beforeEach(() => {
  calls = [];
  respond = () => json({});
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    return Promise.resolve(respond(url));
  });
  clearJsonCache();
  resetProviderStore();
  useUsageStore.setState({ usage: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('error helpers', () => {
  const unsupported = new ApiError('news is not supported', 501, {
    detail: 'news is not supported',
    code: 'unsupported',
    feature: 'news',
    provider: 'twelvedata',
  });
  const notConfigured = new ApiError('TWELVEDATA_API_KEY is not set', 503, {
    detail: 'TWELVEDATA_API_KEY is not set',
    code: 'not_configured',
  });

  it('does not retry 501, but still retries other server errors', () => {
    expect(isRetryable(unsupported)).toBe(false);
    expect(isRetryable(new ApiError('x', 500))).toBe(true);
    expect(isRetryable(new ApiError('x', 502))).toBe(true);
    expect(isRetryable(notConfigured)).toBe(true);
    expect(isRetryable(new ApiError('x', 0))).toBe(true);
    expect(isRetryable(new ApiError('x', 429))).toBe(true);
    expect(isRetryable(new ApiError('x', 404))).toBe(false);
  });

  it('retries the 503 of a provider switch in progress', () => {
    const switched = new ApiError('data source changed; retry', 503, {
      detail: 'data source changed; retry',
      code: 'provider_switched',
    });
    expect(isRetryable(switched)).toBe(true);
    expect(isNotConfigured(switched)).toBe(false);
    expect(classifyChartError(switched)).toBe('unavailable'); // counts down and retries
  });

  it('recognises unsupported and not-configured answers', () => {
    expect(isUnsupported(unsupported)).toBe(true);
    expect(isUnsupported(notConfigured)).toBe(false);
    expect(isUnsupported(new ApiError('x', 502))).toBe(false);
    expect(isUnsupported(new Error('x'))).toBe(false);
    expect(isNotConfigured(notConfigured)).toBe(true);
    expect(isNotConfigured(new ApiError('down', 503))).toBe(false);
    expect(isNotConfigured(unsupported)).toBe(false);
    expect(isNotConfigured(null)).toBe(false);
  });

  it('reads the code from a real error response', async () => {
    respond = () => json({ detail: 'nope', code: 'unsupported', feature: 'news' }, 501);
    const { getJson } = await import('./client');
    const err = await getJson('/news/AAPL').catch((e: unknown) => e);
    expect(isUnsupported(err)).toBe(true);
    expect((err as ApiError).body).toMatchObject({ feature: 'news' });
  });
});

describe('capabilities', () => {
  const providers = (over: Partial<ProvidersResponse> = {}): ProvidersResponse => ({
    active: 'twelvedata',
    setting: 'MARKET_PROVIDER',
    switchable: true,
    selectedBy: 'default',
    providers: [
      { id: 'twelvedata', name: 'Twelve Data' } as ProvidersResponse['providers'][number],
    ],
    activeCapabilities: { ...FULL_CAPABILITIES, news: false, extendedQuotes: false },
    effectiveLimits: {
      creditsPerMin: 8,
      dailyCredits: 800,
      quoteTtlS: 300,
      pollIntervalS: 300,
      source: 'plan',
    },
    ...over,
  });

  it('assumes everything is supported until /providers answered', () => {
    expect(getCapabilities()).toEqual(FULL_CAPABILITIES);
    expect(useProviderStore.getState().loaded).toBe(false);
  });

  it('stays optimistic when /providers fails, and asks again later', async () => {
    respond = () => json({ detail: 'down' }, 502);
    await loadProvider();
    expect(getCapabilities().news).toBe(true);
    expect(useProviderStore.getState().loaded).toBe(false);
    clearJsonCache();
    respond = () => json(providers());
    await loadProvider();
    expect(getCapabilities().news).toBe(false);
    expect(useProviderStore.getState().name).toBe('Twelve Data');
  });

  it('takes the active provider capabilities and fetches once', async () => {
    respond = () => json(providers());
    await loadProvider();
    await loadProvider();
    expect(getCapabilities()).toMatchObject({ news: false, extendedQuotes: false, search: true });
    expect(calls).toEqual(['/api/providers']);
  });

  it('setActiveProvider POSTs the id and answers with the new providers body', async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push(url);
      inits.push(init);
      return Promise.resolve(json(providers({ active: 'demo', selectedBy: 'ui' })));
    });
    const r = await setActiveProvider('demo');
    expect(calls).toEqual(['/api/providers/active']);
    expect(inits[0]?.method).toBe('POST');
    expect(JSON.parse(String(inits[0]?.body))).toEqual({ id: 'demo' });
    expect(r).toMatchObject({ active: 'demo', selectedBy: 'ui' });
  });

  it('resetProviderStore also forgets the cached /providers answer', async () => {
    respond = () => json(providers());
    await loadProvider();
    resetProviderStore();
    respond = () => json(providers({ active: null }));
    await loadProvider();
    expect(calls).toEqual(['/api/providers', '/api/providers']);
    expect(useProviderStore.getState().name).toBe('this data provider');
  });

  it('names a custom provider generically', async () => {
    respond = () => json(providers({ active: null }));
    await loadProvider();
    expect(useProviderStore.getState().name).toBe('this data provider');
  });
});

describe('usage polling', () => {
  const usage = (over: Partial<Usage> = {}): Usage => ({
    plan: 'basic',
    metered: true,
    minute: { limit: 8, left: 8 },
    daily: { limit: 800, used: 10, resetAt: '2026-10-28T00:00:00Z' },
    state: 'ok',
    retryAfterS: 0,
    ...over,
  });
  const fetched = () => calls.filter((c) => c === '/api/providers/usage').length;

  it('polls every 60 s while metered, and stops when released', async () => {
    vi.useFakeTimers();
    respond = () => json(usage());
    const release = watchUsage();
    await vi.advanceTimersByTimeAsync(0);
    expect(useUsageStore.getState().usage?.metered).toBe(true);
    expect(fetched()).toBe(1);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetched()).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(fetched()).toBe(2);
  });

  it('asks an unmetered provider only once', async () => {
    vi.useFakeTimers();
    respond = () => json(usage({ metered: false, daily: null }));
    const release = watchUsage();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
    expect(fetched()).toBe(1);
    release();
  });

  it('shares one poll between callers', async () => {
    vi.useFakeTimers();
    respond = () => json(usage());
    const a = watchUsage();
    const b = watchUsage();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetched()).toBe(2);
    a();
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(fetched()).toBe(3);
    b();
  });

  it('keeps the last reading when a poll fails', async () => {
    vi.useFakeTimers();
    respond = () => json(usage({ state: 'throttled', retryAfterS: 20 }));
    const release = watchUsage();
    await vi.advanceTimersByTimeAsync(0);
    respond = () => json({ detail: 'down' }, 502);
    await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
    expect(useUsageStore.getState().usage?.state).toBe('throttled');
    release();
  });
});

/**
 * The market data provider this API runs on: what it can do (capabilities), what it
 * costs (budget) and how much of that budget is left. Shapes of `GET /providers` and
 * `GET /providers/usage` (api/src/tickerglass_api/routes/providers.py).
 *
 * Until `/providers` has answered (or when it fails) every capability counts as
 * supported: a missing feature then shows as the API's own 501, never as a feature
 * switched off by a failed request.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { cachedJson, clearJsonCache, getJson, requestJson } from './client';

export interface Capabilities {
  /** Canonical interval names the provider serves (natively or synthesized). */
  intervals: string[];
  extendedHistory: boolean;
  extendedQuotes: boolean;
  adjustedClose: boolean;
  search: boolean;
  /** Subset of "dividends", "splits", "earnings". */
  events: string[];
  news: boolean;
  fundamentalsInfo: boolean;
  fundamentalsStatements: boolean;
  streaming: boolean;
  /** Subset of "us", "intl", "fx", "crypto", "index", "futures". */
  markets: string[];
}

export interface ProviderBudget {
  ratePerMin: number;
  burst: number;
  /** Credits per UTC day; null without a daily cap. */
  daily: number | null;
}

export interface ProviderCosts {
  history: number;
  symbolInfo: number;
  search: number;
  quoteBatch: number;
  quotePerRequest: number;
  quotePerSymbol: number;
  events: number;
  news: number;
  fundamentals: number;
}

/** One setting of a provider; `value` is null for secrets (their values never leave the API). */
export interface ConfigField {
  name: string;
  env: string;
  label: string;
  secret: boolean;
  required: boolean;
  /** The user set it (otherwise the default applies). */
  set: boolean;
  value: unknown;
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  network: boolean;
  terms: string | null;
  /** False when required settings are missing: every call answers 503 "not_configured". */
  configured: boolean;
  capabilities: Capabilities;
  costs: ProviderCosts;
  budget: ProviderBudget;
  config: ConfigField[];
  plan: string | null;
}

export interface EffectiveLimits {
  creditsPerMin: number;
  dailyCredits: number | null;
  quoteTtlS: number;
  pollIntervalS: number;
  /** Where the numbers come from: the plan, env settings, or what the upstream reported. */
  source: 'plan' | 'env' | 'calibrated';
}

export interface ProvidersResponse {
  /** Id of the provider in use; null for a custom one. */
  active: string | null;
  /** Environment variable that picks the provider. */
  setting: string;
  /** The provider can be changed from the app (false: `PROVIDER_SWITCHING=false` or a custom provider). */
  switchable: boolean;
  /** How the provider in use was chosen: in the app, `MARKET_PROVIDER`, or the default. */
  selectedBy: 'ui' | 'env' | 'default';
  providers: ProviderInfo[];
  activeCapabilities: Capabilities;
  effectiveLimits: EffectiveLimits;
}

export type UsageState = 'ok' | 'throttled' | 'exhausted';

export interface Usage {
  plan: string | null;
  /** The provider has credits to run out of; only then is usage polled. */
  metered: boolean;
  minute: { limit: number; left: number };
  /** Daily credits; `resetAt` is the ISO time of the next reset (UTC midnight). */
  daily: { limit: number; used: number; resetAt: string } | null;
  state: UsageState;
  retryAfterS: number;
}

/** Everything supported: what is assumed while the real capabilities are unknown. */
export const FULL_CAPABILITIES: Capabilities = {
  intervals: [],
  extendedHistory: true,
  extendedQuotes: true,
  adjustedClose: true,
  search: true,
  events: ['dividends', 'splits', 'earnings'],
  news: true,
  fundamentalsInfo: true,
  fundamentalsStatements: true,
  streaming: true,
  markets: ['us', 'intl', 'fx', 'crypto', 'index', 'futures'],
};

const PROVIDERS_TTL_MS = 30_000;

export const getProviders = (): Promise<ProvidersResponse> =>
  cachedJson<ProvidersResponse>('/providers', PROVIDERS_TTL_MS);

/**
 * Switch the provider in use (`POST /providers/active`). The API clears its cached market
 * data; the answer is the same body as `GET /providers` for the new provider. Errors carry the
 * server's `detail` (403 switching disabled, 409 not configured / custom provider, 422 unknown).
 */
export function setActiveProvider(id: string): Promise<ProvidersResponse> {
  return requestJson<ProvidersResponse>('POST', '/providers/active', { id });
}

/** Name used in messages when the API runs on a custom provider. */
export const CUSTOM_PROVIDER_NAME = 'this data provider';

interface ProviderState {
  /** `/providers` answered. */
  loaded: boolean;
  active: string | null;
  /** Display name of the provider in use. */
  name: string;
  capabilities: Capabilities;
}

let loading: Promise<void> | null = null;

export const useProviderStore = create<ProviderState>()(() => ({
  loaded: false,
  active: null,
  name: CUSTOM_PROVIDER_NAME,
  capabilities: FULL_CAPABILITIES,
}));

/**
 * Back to "unknown, everything supported" (tests; the provider changed under this tab): the
 * next `loadProvider` asks again, past the 30 s `/providers` cache.
 */
export function resetProviderStore(): void {
  clearJsonCache();
  useProviderStore.setState({
    loaded: false,
    active: null,
    name: CUSTOM_PROVIDER_NAME,
    capabilities: FULL_CAPABILITIES,
  });
  loading = null;
}

/** Fetch the provider info once; a failure leaves the defaults and the next call retries. */
export function loadProvider(): Promise<void> {
  if (useProviderStore.getState().loaded) return Promise.resolve();
  loading ??= getProviders().then(
    (r) => {
      const name = r.providers.find((p) => p.id === r.active)?.name ?? CUSTOM_PROVIDER_NAME;
      useProviderStore.setState({
        loaded: true,
        active: r.active,
        name,
        capabilities: { ...FULL_CAPABILITIES, ...r.activeCapabilities },
      });
    },
    () => {
      loading = null; // unreachable or failing: assume everything works, ask again later
    },
  );
  return loading;
}

/** Capabilities outside React (the quote stream). */
export const getCapabilities = (): Capabilities => useProviderStore.getState().capabilities;

/** Capabilities of the provider in use; everything counts as supported while unknown. */
export function useCapabilities(): Capabilities {
  useEffect(() => {
    void loadProvider();
  }, []);
  return useProviderStore((s) => s.capabilities);
}

/** Display name of the provider in use ("this data provider" while unknown or custom). */
export function useProviderName(): string {
  return useProviderStore((s) => s.name);
}

// ---------------------------------------------------------------- usage

export const USAGE_POLL_MS = 60_000;

export const useUsageStore = create<{ usage: Usage | null }>()(() => ({ usage: null }));

/** Read the guard's accounting now (no upstream credits). A failure keeps the last reading. */
export async function refreshUsage(): Promise<void> {
  try {
    useUsageStore.setState({ usage: await getJson<Usage>('/providers/usage') });
  } catch {
    // Keep the last reading: the chip and the budget bar only show what is known.
  }
}

let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const usage = useUsageStore.getState().usage;
  // A provider without credits is asked once; a failed first reading is asked again.
  if (usage === null || usage.metered) void refreshUsage();
}

/** Start polling while at least one component uses it; returns the release function. */
export function watchUsage(): () => void {
  users++;
  if (users === 1) {
    void refreshUsage();
    timer = setInterval(tick, USAGE_POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users--;
    if (users === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * Credit usage of the provider in use, polled every 60 s and only when it is metered
 * (null until the first reading). One shared poll serves every caller.
 */
export function useUsage(): Usage | null {
  useEffect(() => watchUsage(), []);
  return useUsageStore((s) => s.usage);
}

/** True when the provider is metered (its search is debounced and needs two characters). */
export function useMetered(): boolean {
  return useUsage()?.metered === true;
}

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FULL_CAPABILITIES,
  type ConfigField,
  type EffectiveLimits,
  type ProviderInfo,
  type Usage,
} from '../api/provider';
import { ProviderCard, ProviderDetails, TestStatus } from './DataSourceDialog';

const SECRET = 'sk-live-0123456789abcdef';

const field = (over: Partial<ConfigField>): ConfigField => ({
  name: 'x',
  env: 'X',
  label: 'x',
  secret: false,
  required: false,
  set: false,
  value: null,
  ...over,
});

const twelve = (over: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'twelvedata',
  name: 'Twelve Data',
  description: 'Stocks, forex and crypto over HTTP.',
  network: true,
  terms: null,
  configured: true,
  capabilities: {
    ...FULL_CAPABILITIES,
    streaming: false,
    extendedHistory: false,
    news: false,
    events: [],
    markets: ['us', 'fx', 'crypto'],
  },
  costs: {
    history: 1,
    symbolInfo: 1,
    search: 1,
    quoteBatch: 120,
    quotePerRequest: 0,
    quotePerSymbol: 1,
    events: 20,
    news: 1,
    fundamentals: 10,
  },
  budget: { ratePerMin: 8, burst: 8, daily: 800 },
  config: [
    // A secret never carries its value; if a server sent one anyway it must not show.
    field({
      name: 'api_key',
      env: 'TWELVEDATA_API_KEY',
      label: 'API key',
      secret: true,
      required: true,
      set: true,
      value: SECRET,
    }),
    field({ name: 'plan', env: 'TWELVEDATA_PLAN', label: 'Plan', set: true, value: 'basic' }),
    field({
      name: 'credits_per_min',
      env: 'TWELVEDATA_CREDITS_PER_MIN',
      label: 'Credits per minute',
    }),
  ],
  plan: 'basic',
  ...over,
});

const limits: EffectiveLimits = {
  creditsPerMin: 8,
  dailyCredits: 800,
  quoteTtlS: 300,
  pollIntervalS: 300,
  source: 'plan',
};

const usage: Usage = {
  plan: 'basic',
  metered: true,
  minute: { limit: 8, left: 6 },
  daily: { limit: 800, used: 200, resetAt: '2026-10-28T00:00:00Z' },
  state: 'ok',
  retryAfterS: 0,
};

const render = (p: ProviderInfo, active = true, u: Usage | null = usage) =>
  renderToStaticMarkup(
    <ul>
      <ProviderCard
        p={p}
        active={active}
        setting="MARKET_PROVIDER"
        limits={limits}
        usage={u}
        now={Date.parse('2026-10-27T10:00:00Z')}
      />
    </ul>,
  );

const renderDetails = (
  p: ProviderInfo,
  over: { active?: boolean; selectedBy?: string; usage?: Usage | null } = {},
) =>
  renderToStaticMarkup(
    <ProviderDetails
      p={p}
      active={over.active ?? true}
      selectedBy={over.selectedBy}
      limits={limits}
      usage={over.usage ?? usage}
      now={Date.parse('2026-10-27T10:00:00Z')}
    />,
  );

describe('ProviderCard', () => {
  it('shows only the essentials while collapsed: name, description, status, details toggle', () => {
    const html = render(twelve());
    expect(html).toContain('Twelve Data');
    expect(html).toContain('Stocks, forex and crypto over HTTP.');
    expect(html).toContain('In use');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Details');
    // The technical detail lives behind the disclosure.
    expect(html).not.toContain('ds-chip');
    expect(html).not.toContain('TWELVEDATA_API_KEY');
    expect(html).not.toContain('Plan: basic');
    expect(html).not.toContain('credits per minute');
    expect(html).not.toContain('progressbar');
  });

  it('shows the not-configured state as one line naming what to set', () => {
    const html = render(
      twelve({
        configured: false,
        config: [
          field({ env: 'TWELVEDATA_API_KEY', label: 'API key', secret: true, required: true }),
        ],
      }),
    );
    expect(html).toContain('Needs TWELVEDATA_API_KEY set in .env and an API restart.');
    expect(render(twelve())).not.toContain('ds-missing');
  });

  it('keeps the instructions for switching to a provider that is not in use when switching is locked', () => {
    const html = render(twelve(), false);
    expect(html).toContain('To use it, set');
    expect(html).toContain('MARKET_PROVIDER=twelvedata');
    expect(html).toContain('in .env and restart the API.');
    expect(render(twelve(), true)).not.toContain('To use it, set');
  });
});

describe('ProviderDetails', () => {
  it('lists the config env lines with set / missing / default badges', () => {
    const html = renderDetails(twelve());
    expect(html).toContain('TWELVEDATA_API_KEY');
    expect(html).toContain('TWELVEDATA_PLAN=basic');
    expect(html).toContain('TWELVEDATA_CREDITS_PER_MIN');
    expect(html).toContain('ds-badge set');
    expect(html).toContain('ds-badge default');
    const missing = renderDetails(
      twelve({
        configured: false,
        config: [
          field({ env: 'TWELVEDATA_API_KEY', label: 'API key', secret: true, required: true }),
        ],
      }),
    );
    expect(missing).toContain('ds-badge missing');
  });

  it('never shows a secret value', () => {
    const html = renderDetails(twelve());
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('sk-live');
    expect(html).not.toContain('TWELVEDATA_API_KEY=');
    expect(render(twelve())).not.toContain(SECRET);
  });

  it('shows the status meta line, capability chips and the usage bar for the active provider', () => {
    const html = renderDetails(twelve());
    expect(html).toContain('Online');
    expect(html).toContain('Plan: basic');
    expect(html).toContain('aria-label="Live stream: not available"');
    expect(html).toContain('aria-label="Search: available"');
    expect(html).toContain('US stocks');
    expect(html).toContain('8 credits per minute, 800 per day (from your plan)');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('200 of 800 used');
    expect(html).toContain('6 of 8 left');
  });

  it('shows the terms note when the provider carries one', () => {
    // Static markup HTML-escapes the apostrophe, so match a fragment without it.
    expect(renderDetails(twelve({ terms: "Yahoo's terms allow personal use only." }))).toContain(
      'terms allow personal use only',
    );
    expect(renderDetails(twelve())).not.toContain('ds-terms');
  });

  it('has no usage bar or limits for a provider that is not metered or not in use', () => {
    expect(
      renderDetails(twelve(), { usage: { ...usage, metered: false, daily: null } }),
    ).not.toContain('progressbar');
    expect(renderDetails(twelve(), { active: false })).not.toContain('progressbar');
    expect(renderDetails(twelve(), { active: false })).not.toContain('credits per minute');
  });

  it('notes how the provider in use was chosen', () => {
    expect(renderDetails(twelve(), { selectedBy: 'selected in app' })).toContain('selected in app');
    // The collapsed card stays free of it.
    expect(render(twelve())).not.toContain('selected in app');
  });
});

describe('ProviderCard onUse', () => {
  const renderUse = (p: ProviderInfo, over: { onUse?: boolean; busy?: boolean } = {}) =>
    renderToStaticMarkup(
      <ul>
        <ProviderCard
          p={p}
          active={false}
          setting="MARKET_PROVIDER"
          now={0}
          onUse={over.onUse === false ? undefined : () => undefined}
          busy={over.busy}
        />
      </ul>,
    );

  it('puts a Use button on a configured provider instead of the .env instructions', () => {
    const html = renderUse(twelve());
    expect(html).toContain('aria-label="Use Twelve Data"');
    expect(html).not.toContain('To use it, set');
    expect(html).not.toContain('MARKET_PROVIDER=twelvedata');
  });

  it('disables the button while a switch is under way', () => {
    expect(renderUse(twelve(), { busy: true })).toMatch(
      /aria-label="Use Twelve Data"[^>]*disabled/,
    );
  });

  it('offers no Use for an unconfigured provider, only what to set', () => {
    const html = renderUse(
      twelve({
        configured: false,
        config: [field({ env: 'TWELVEDATA_API_KEY', secret: true, required: true })],
      }),
    );
    expect(html).not.toContain('aria-label="Use Twelve Data"');
    expect(html).toContain('Needs TWELVEDATA_API_KEY set in .env');
  });

  it('keeps the .env instructions without onUse (switching disabled)', () => {
    const html = renderUse(twelve(), { onUse: false });
    expect(html).toContain('To use it, set');
    expect(html).toContain('MARKET_PROVIDER=twelvedata');
    expect(html).not.toContain('aria-label="Use Twelve Data"');
  });
});

describe('TestStatus', () => {
  it('reports a successful connection compactly', () => {
    const html = renderToStaticMarkup(
      <TestStatus test={{ ok: true, symbol: 'SPY', price: 767.89, latencyMs: 1297 }} />,
    );
    expect(html).toContain('Connected · SPY 767.89 · 1297 ms');
  });

  it('reports a provider without its settings as not configured', () => {
    const html = renderToStaticMarkup(
      <TestStatus
        test={{
          ok: false,
          symbol: 'SPY',
          error: 'TWELVEDATA_API_KEY is not set',
          code: 'not_configured',
        }}
      />,
    );
    expect(html).toContain('Not configured: TWELVEDATA_API_KEY is not set');
    expect(html).not.toContain('No data');
  });

  it('still reports other failures as no data', () => {
    const html = renderToStaticMarkup(
      <TestStatus test={{ ok: false, symbol: 'SPY', error: 'boom' }} />,
    );
    expect(html).toContain('No data for SPY: boom');
  });
});

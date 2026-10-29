import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FULL_CAPABILITIES, type ProviderInfo, type ProvidersResponse } from '../api/provider';
import { ProviderPicker, lockedText, selectedByText } from './ProviderPicker';

const provider = (over: Partial<ProviderInfo>): ProviderInfo => ({
  id: 'yahoo',
  name: 'Yahoo Finance',
  description: 'Free quotes.',
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
    quotePerSymbol: 0,
    events: 1,
    news: 1,
    fundamentals: 1,
  },
  budget: { ratePerMin: 60, burst: 60, daily: null },
  config: [],
  plan: null,
  ...over,
});

const twelve = provider({
  id: 'twelvedata',
  name: 'Twelve Data',
  configured: false,
  config: [
    {
      name: 'api_key',
      env: 'TWELVEDATA_API_KEY',
      label: 'API key',
      secret: true,
      required: true,
      set: false,
      value: null,
    },
  ],
});

const info = (over: Partial<ProvidersResponse> = {}): ProvidersResponse => ({
  active: 'yahoo',
  setting: 'MARKET_PROVIDER',
  switchable: true,
  selectedBy: 'default',
  providers: [
    provider({}),
    provider({ id: 'demo', name: 'Demo', description: 'Offline sample data.', network: false }),
    twelve,
  ],
  activeCapabilities: FULL_CAPABILITIES,
  effectiveLimits: {
    creditsPerMin: 60,
    dailyCredits: null,
    quoteTtlS: 30,
    pollIntervalS: 5,
    source: 'env',
  },
  ...over,
});

const render = (i: ProvidersResponse, busy = false) =>
  renderToStaticMarkup(<ProviderPicker info={i} onUse={() => undefined} busy={busy} />);

describe('ProviderPicker', () => {
  it('offers Use on a configured provider and marks the one in use', () => {
    const html = render(info());
    expect(html).toContain('aria-label="Use Demo"');
    expect(html).not.toContain('aria-label="Use Yahoo Finance"');
    expect(html).toContain('In use');
    expect(html).toContain('(default)');
    expect(html).not.toContain('To use it, set');
    expect(html).not.toContain('Switching is disabled');
  });

  it('says how the provider in use was chosen', () => {
    expect(render(info({ selectedBy: 'ui' }))).toContain('(selected in app)');
    expect(render(info({ selectedBy: 'env' }))).toContain('(from MARKET_PROVIDER)');
    expect(selectedByText(info({ selectedBy: 'env' }))).toBe('from MARKET_PROVIDER');
  });

  it('disables an unconfigured provider and names what to set', () => {
    const html = render(info());
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Use Twelve Data"/);
    expect(html).toContain('Set TWELVEDATA_API_KEY in .env and restart the API.');
  });

  it('disables the buttons while a switch is under way', () => {
    const html = render(info(), true);
    expect(html).toMatch(/<button[^>]*aria-label="Use Demo"[^>]*disabled=""/);
  });

  it('is read-only when switching is disabled: note plus the env instructions', () => {
    const html = render(info({ switchable: false }));
    expect(html).toContain('Switching is disabled (PROVIDER_SWITCHING=false).');
    expect(html).not.toContain('aria-label="Use Demo"');
    expect(html).toContain('MARKET_PROVIDER=demo');
    expect(html).toContain('in .env and restart the API.');
    expect(html).toContain('Set TWELVEDATA_API_KEY in .env');
  });

  it('is read-only on a custom provider', () => {
    const i = info({ switchable: false, active: null });
    expect(lockedText(i)).toContain('custom provider');
    expect(render(i)).not.toContain('aria-label="Use Demo"');
  });
});

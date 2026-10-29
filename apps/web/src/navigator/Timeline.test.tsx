import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_CAPABILITIES, type Capabilities } from '../api/provider';

const provider = vi.hoisted(() => ({ caps: null as Capabilities | null, name: 'Twelve Data' }));
vi.mock('../api/provider', async (orig) => {
  const actual = await orig<typeof import('../api/provider')>();
  return {
    ...actual,
    useCapabilities: () => provider.caps ?? actual.FULL_CAPABILITIES,
    useProviderName: () => provider.name,
  };
});

const api = vi.hoisted(() => ({ paths: [] as (string | null)[] }));
vi.mock('../sidebar/hooks', async (orig) => {
  const actual = await orig<typeof import('../sidebar/hooks')>();
  return {
    ...actual,
    useApi: (path: string | null) => {
      api.paths.push(path);
      return { data: undefined, error: null, loading: false, retry: () => undefined };
    },
  };
});

import { Timeline } from './Timeline';

beforeEach(() => {
  provider.caps = null;
  api.paths = [];
});

describe('Timeline without news', () => {
  it('says news is not available from the provider and does not ask for it', () => {
    provider.caps = { ...FULL_CAPABILITIES, news: false };
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).toContain('News: not available from Twelve Data');
    expect(api.paths.some((p) => p?.startsWith('/news'))).toBe(false);
  });

  it('shows no notice and asks for news when the provider has it', () => {
    const html = renderToStaticMarkup(<Timeline />);
    expect(html).not.toContain('not available from');
    expect(api.paths.some((p) => p?.startsWith('/news/'))).toBe(true);
  });

  it('does not ask for events when the provider has none', () => {
    provider.caps = { ...FULL_CAPABILITIES, events: [] };
    renderToStaticMarkup(<Timeline />);
    expect(api.paths.some((p) => p?.includes('/events'))).toBe(false);
    api.paths = [];
    provider.caps = null;
    renderToStaticMarkup(<Timeline />);
    expect(api.paths.some((p) => p?.includes('/events'))).toBe(true);
  });
});

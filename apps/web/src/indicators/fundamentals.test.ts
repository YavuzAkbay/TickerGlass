import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJsonCache } from '../api/client';
import { FULL_CAPABILITIES, resetProviderStore, useProviderStore } from '../api/provider';
import { fetchFundamentals } from './fundamentals';

let calls: string[] = [];
let status = 200;

beforeEach(() => {
  calls = [];
  status = 200;
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    const body = status === 200 ? { financials: {} } : { detail: 'no', code: 'unsupported' };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  clearJsonCache();
  resetProviderStore();
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchFundamentals', () => {
  it('fetches the statements when the provider has them', async () => {
    await expect(fetchFundamentals('AAPL')).resolves.toEqual({ financials: {} });
    expect(calls).toEqual(['/api/fundamentals/AAPL']);
  });

  it('rejects with a clear message, without a request, when the provider has no statements', async () => {
    useProviderStore.setState({
      name: 'Twelve Data',
      capabilities: { ...FULL_CAPABILITIES, fundamentalsStatements: false },
    });
    await expect(fetchFundamentals('AAPL')).rejects.toThrow('not available from Twelve Data');
    expect(calls).toEqual([]);
  });

  it('turns a 501 into the same message', async () => {
    status = 501;
    useProviderStore.setState({ name: 'Yahoo' });
    await expect(fetchFundamentals('AAPL')).rejects.toThrow('not available from Yahoo');
  });
});

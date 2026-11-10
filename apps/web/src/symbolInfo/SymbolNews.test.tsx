import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newsCache, clearSymbolInfoCaches } from './api';
import { SymbolNews } from './SymbolNews';

const requestJson = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  requestJson,
}));

const item = (over: Record<string, unknown>) => ({
  id: 'n',
  title: 'Headline',
  publisher: 'Wire',
  url: 'https://example.com/a',
  time: Math.floor(Date.now() / 1000) - 600,
  thumbnail: null,
  ...over,
});

async function render(items: unknown[]): Promise<string> {
  requestJson.mockResolvedValue(items);
  await newsCache.get('AAPL'); // effects do not run in a static render: serve from the cache
  return renderToStaticMarkup(<SymbolNews symbol="AAPL" />);
}

describe('SymbolNews', () => {
  beforeEach(() => {
    clearSymbolInfoCaches();
    requestJson.mockReset();
  });

  it('asks for the background-priority feed once', async () => {
    await render([item({})]);
    await newsCache.get('AAPL');
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith('GET', '/news/AAPL', undefined, {
      headers: { 'X-TickerGlass-Priority': 'background' },
      query: { limit: 8 },
    });
  });

  it('links to http(s) articles in a new tab without opener access', async () => {
    const out = await render([item({ title: 'Earnings beat' })]);
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('Earnings beat');
    expect(out).toContain('Wire · 10m ago');
  });

  it('renders markup as text and never links a non-http url', async () => {
    const out = await render([
      item({ id: '1', title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }),
      item({ id: '2', title: 'Data link', url: 'data:text/html,<b>x</b>' }),
    ]);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text');
    expect(out).not.toContain('<a ');
    expect(out).toContain('Data link');
  });

  it('skips items without a title and says so when nothing is left', async () => {
    const out = await render([item({ title: '  ' }), item({ title: null })]);
    expect(out).toContain('No recent news');
  });
});

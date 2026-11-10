import { describe, expect, it, vi, afterEach } from 'vitest';
import { checkForUpdate, compareVersions } from './updates';

afterEach(() => vi.unstubAllGlobals());

describe('compareVersions', () => {
  it('orders numeric parts', () => {
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1);
  });

  it('handles different part counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  it('detects an update and keeps the release URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ tag_name: 'v1.2.3', html_url: 'https://x/re/tag/v1.2.3' }), {
          status: 200,
        }),
      ),
    );
    const r = await checkForUpdate('1.0.0');
    expect(r.updateAvailable).toBe(true);
    expect(r.latest).toBe('1.2.3');
    expect(r.current).toBe('1.0.0');
    expect(r.releaseUrl).toBe('https://x/re/tag/v1.2.3');
    expect(r.error).toBeNull();
  });

  it('ignores a leading v on both sides', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v0.2.0' }), { status: 200 })),
    );
    const r = await checkForUpdate('v0.2.0');
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBe('0.2.0');
  });

  it('maps rate limiting, 404 and network failures to errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    expect((await checkForUpdate('0.1.0')).error).toBe('rate-limited');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect((await checkForUpdate('0.1.0')).error).toBe('no-releases');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('down'))));
    expect((await checkForUpdate('0.1.0')).error).toBe('network');
  });
});

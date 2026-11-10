import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { clearHotlistCache, getHotlist } from './api';
import type { HotlistResponse } from './kinds';

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[] = [];
let respond: (call: Call) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const headerOf = (c: Call, name: string): string | undefined =>
  (c.init.headers as Record<string, string>)[name];
const RES = { kind: 'gainers', universe: 'stocks', asOf: '2026-11-05', rows: [] };
const body = RES as unknown as HotlistResponse;

beforeEach(() => {
  calls = [];
  clearHotlistCache();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getHotlist', () => {
  it('revalidates with the stored ETag (304 -> the cached body)', async () => {
    respond = (c) =>
      headerOf(c, 'If-None-Match') === '"h1"'
        ? new Response(null, { status: 304 })
        : json(RES, 200, { ETag: '"h1"' });
    const first = await getHotlist('gainers', 'stocks');
    expect(calls[0]!.url).toContain('/api/screener/hotlists?');
    expect(headerOf(calls[0]!, 'If-None-Match')).toBeUndefined();
    const second = await getHotlist('gainers', 'stocks');
    expect(headerOf(calls[1]!, 'If-None-Match')).toBe('"h1"');
    expect(second).toBe(first);
    expect(second).toEqual(body);
  });

  it('keeps one ETag per ranking', async () => {
    respond = () => json(RES, 200, { ETag: '"e"' });
    await getHotlist('gainers', 'stocks');
    await getHotlist('losers', 'stocks');
    expect(headerOf(calls[1]!, 'If-None-Match')).toBeUndefined();
  });

  it('a changed answer replaces the cached one', async () => {
    respond = () => json(RES, 200, { ETag: '"a"' });
    await getHotlist('gainers', 'stocks');
    respond = () => json({ ...RES, asOf: '2026-11-06' }, 200, { ETag: '"b"' });
    expect((await getHotlist('gainers', 'stocks')).asOf).toBe('2026-11-06');
    respond = (c) =>
      headerOf(c, 'If-None-Match') === '"b"' ? new Response(null, { status: 304 }) : json(RES);
    expect((await getHotlist('gainers', 'stocks')).asOf).toBe('2026-11-06');
  });

  it('maps an error answer to an ApiError', async () => {
    respond = () => json({ detail: { code: 'bad_value', message: 'invalid universe' } }, 422);
    await expect(getHotlist('gainers', 'nope')).rejects.toBeInstanceOf(ApiError);
  });
});

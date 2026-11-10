import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearJsonCache } from '../../api/client';
import { clearUniverseCache, getUniverse, UniverseUnavailableError } from '../universe';
import {
  clearScreenerCache,
  createScreen,
  getFields,
  isRunConflict,
  runConflictMessage,
  saveScreen,
  scan,
  scanAll,
  scanErrorDetail,
  scanKey,
  triggerRun,
} from './api';
import type { ScanRequest, ScanResponse, Screen, ScreenSpec } from './types';

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const headerOf = (c: Call, name: string): string | undefined =>
  (c.init.headers as Record<string, string>)[name];
const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  clearScreenerCache();
  clearJsonCache();
  clearUniverseCache();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const REQ: ScanRequest = {
  universe: { kind: 'class', cls: 'stocks' },
  filter: { op: 'and', rules: [{ field: 'rsi14', op: '<', value: 30 }] },
  sort: { field: 'mcap', dir: 'desc' },
  limit: 100,
  offset: 0,
};
const RES = (over: Partial<ScanResponse> = {}): ScanResponse => ({
  asOf: '2026-11-05',
  computedAt: '2026-11-05T22:00:00Z',
  provider: 'yahoo',
  total: 1,
  offset: 0,
  limit: 100,
  coverage: { universe: 10, withSnapshot: 10 },
  rows: [],
  ...over,
});

describe('scan', () => {
  it('posts the request and revalidates with the stored ETag (304 -> cached body)', async () => {
    respond = (c) =>
      headerOf(c, 'If-None-Match') === '"abc"'
        ? new Response(null, { status: 304 })
        : json(RES(), 200, { ETag: '"abc"' });
    const first = await scan(REQ);
    expect(calls[0]!.url).toBe('/api/screener/scan');
    expect(calls[0]!.init.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual(REQ);
    expect(headerOf(calls[0]!, 'If-None-Match')).toBeUndefined();
    const second = await scan({ ...REQ });
    expect(headerOf(calls[1]!, 'If-None-Match')).toBe('"abc"');
    expect(second).toBe(first);
  });

  it('keeps one ETag per canonical request', async () => {
    respond = () => json(RES(), 200, { ETag: '"e"' });
    await scan(REQ);
    await scan({ ...REQ, offset: 100 });
    expect(headerOf(calls[1]!, 'If-None-Match')).toBeUndefined();
    await scan({
      sort: REQ.sort,
      filter: REQ.filter,
      universe: REQ.universe,
      offset: 0,
      limit: 100,
    });
    expect(headerOf(calls[2]!, 'If-None-Match')).toBe('"e"');
  });

  it('key order and undefined fields do not matter', () => {
    expect(scanKey(REQ)).toBe(scanKey({ ...REQ, fields: undefined } as unknown as ScanRequest));
  });

  it('maps 422 to an ApiError with the contract detail', async () => {
    respond = () =>
      json(
        { detail: { code: 'unknown_field', message: 'Unknown field "x"', path: 'rules[0]' } },
        422,
      );
    const err = await scan(REQ).catch((e: unknown) => e);
    expect(scanErrorDetail(err)).toEqual({
      code: 'unknown_field',
      message: 'Unknown field "x"',
      path: 'rules[0]',
    });
    expect((err as Error).message).toBe('Unknown field "x"');
  });

  it('reports an unreachable API as status 0', async () => {
    respond = () => {
      throw new TypeError('failed');
    };
    await expect(scan(REQ)).rejects.toMatchObject({ status: 0 });
  });
});

describe('scanAll', () => {
  it('pages sequentially with limit 500 up to the cap', async () => {
    respond = (c) => {
      const b = bodyOf(c) as unknown as ScanRequest;
      const rows = Array.from({ length: Math.min(b.limit, 1200 - b.offset) }, (_, i) => ({
        symbol: `S${b.offset + i}`,
        name: '',
        cls: 'stocks',
        group: '',
        exchange: null,
        stale: false,
        values: {},
      }));
      return json(RES({ total: 1200, offset: b.offset, rows }));
    };
    const { sort, filter, universe } = REQ;
    const all = await scanAll({ universe, filter, sort });
    expect(calls.map((c) => [bodyOf(c).offset, bodyOf(c).limit])).toEqual([
      [0, 500],
      [500, 500],
      [1000, 500], // the last page just comes back shorter
    ]);
    expect(all.rows).toHaveLength(1200);
    expect(all.truncated).toBe(false);

    calls = [];
    const capped = await scanAll({ universe, filter, sort }, 700);
    expect(calls.map((c) => [bodyOf(c).offset, bodyOf(c).limit])).toEqual([
      [0, 500],
      [500, 200],
    ]);
    expect(capped.rows).toHaveLength(700);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(1200);
  });
});

describe('runs', () => {
  it('posts the kind; 409 means a run is in progress', async () => {
    respond = () => json({ runId: 7 }, 202);
    expect(await triggerRun('snapshot')).toEqual({ runId: 7 });
    expect(calls[0]!.url).toBe('/api/screener/runs');
    expect(bodyOf(calls[0]!)).toEqual({ kind: 'snapshot' });
    respond = () => json({ detail: 'running' }, 409);
    const err = await triggerRun().catch((e: unknown) => e);
    expect(isRunConflict(err)).toBe(true);
    expect(runConflictMessage(err)).toBeNull(); // a plain-string detail has no message
    respond = () =>
      json(
        {
          detail: {
            code: 'run_in_progress',
            message: 'snapshots already done for 2026-11-05; retry after 10 min',
          },
        },
        409,
      );
    const cooldown = await triggerRun().catch((e: unknown) => e);
    expect(runConflictMessage(cooldown)).toBe(
      'snapshots already done for 2026-11-05; retry after 10 min',
    );
    expect(runConflictMessage(new Error('x'))).toBeNull();
  });
});

describe('fields', () => {
  it('is fetched once and shared', async () => {
    respond = () => json({ version: 1, fields: [] });
    await Promise.all([getFields(), getFields()]);
    await getFields();
    expect(calls).toHaveLength(1);
  });

  it('a failure is not cached', async () => {
    respond = () => json({ detail: 'boom' }, 500);
    await expect(getFields()).rejects.toMatchObject({ status: 500 });
    respond = () => json({ version: 1, fields: [] });
    await expect(getFields()).resolves.toMatchObject({ version: 1 });
  });
});

describe('screens', () => {
  const spec: ScreenSpec = {
    schemaVersion: 1,
    universe: REQ.universe,
    filter: REQ.filter,
    sort: REQ.sort,
  };
  const screen = (revision: number, name = 'A'): Screen => ({
    id: 's1',
    name,
    spec,
    alert: null,
    revision,
    createdAt: 't',
    updatedAt: 't',
  });

  it('creates with a client id', async () => {
    respond = () => json(screen(1), 201);
    await createScreen({ id: 's1', name: 'A', spec });
    expect(calls[0]!.url).toBe('/api/screener/screens');
    expect(bodyOf(calls[0]!)).toMatchObject({ id: 's1', name: 'A' });
  });

  it('sends the revision on update', async () => {
    respond = () => json(screen(2));
    const out = await saveScreen(screen(1), { name: 'B' });
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/screener/screens/s1');
    expect(bodyOf(calls[0]!)).toMatchObject({ name: 'B', revision: 1, alert: null });
    expect(out.overwrote).toBe(false);
  });

  it('on 409 re-sends on top of the server revision (last writer wins)', async () => {
    let n = 0;
    respond = () =>
      n++ === 0
        ? json({ detail: { message: 'conflict', current: screen(5, 'Elsewhere') } }, 409)
        : json(screen(6, 'B'));
    const out = await saveScreen(screen(1), { name: 'B' });
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toMatchObject({ name: 'B', revision: 5 });
    expect(out).toMatchObject({ overwrote: true, screen: { revision: 6 } });
  });

  it('a 409 without the current screen is rethrown', async () => {
    respond = () => json({ detail: 'conflict' }, 409);
    await expect(saveScreen(screen(1), { name: 'B' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('getUniverse', () => {
  it('prefers the API and keeps the bundled shape', async () => {
    respond = () =>
      json(
        {
          cls: 'etfs',
          groupLabel: 'category',
          capKind: 'aum',
          groups: ['Broad'],
          exchanges: ['NYSE'],
          symbols: [
            { symbol: 'SPY', name: 'SPDR', rank: 1, group: 'Broad', exchange: 'NYSE', cap: 500 },
            { symbol: 'XYZ', name: 'No cap', rank: 2, group: 'Broad', exchange: null, cap: null },
          ],
        },
        200,
        { ETag: '"u"' },
      );
    const u = await getUniverse('etfs');
    expect(calls[0]!.url).toBe('/api/screener/universe?cls=etfs');
    expect(u.symbols[0]!.symbol).toBe('SPY');
    expect(u.symbols[1]).not.toHaveProperty('exchange');
    expect(u.symbols[1]).not.toHaveProperty('cap');
    await getUniverse('etfs');
    expect(calls).toHaveLength(1); // cached per class
  });

  it.each([
    [
      'network error',
      () => {
        throw new TypeError('offline');
      },
    ],
    ['404', () => json({ detail: 'nope' }, 404)],
    ['malformed body', () => json({ cls: 'etfs', symbols: [] })],
    [
      'wrong class',
      () =>
        json({
          cls: 'stocks',
          groupLabel: 'sector',
          capKind: 'mcap',
          symbols: [{ symbol: 'A', name: 'A' }],
          groups: [],
          exchanges: [],
        }),
    ],
  ])('rejects with UniverseUnavailableError on %s (no bundled fallback)', async (_name, answer) => {
    respond = answer as () => Response;
    await expect(getUniverse('etfs')).rejects.toBeInstanceOf(UniverseUnavailableError);
  });
});

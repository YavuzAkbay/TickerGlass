import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver, createLayoutAutosaver } from './autosave';
import { ApiError, requestJson } from './client';
import {
  batchDrawings,
  drawingConflicts,
  getDrawings,
  getLastUsedLayout,
  importAll,
  importLayout,
  isConflict,
  layoutConflict,
  noteConflict,
  patchSettings,
  saveLayout,
} from './persistence';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const bodyOf = (c: Call) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

beforeEach(() => {
  calls = [];
  respond = () => json({});
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('requestJson', () => {
  it('sends method, JSON body, query and keepalive', async () => {
    respond = () => json({ ok: 1 });
    const out = await requestJson('POST', '/x', { a: 1 }, {
      query: { mode: 'merge', dryRun: true, skip: undefined },
      keepalive: true,
    });
    expect(out).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe('/api/x?mode=merge&dryRun=true');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.keepalive).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(bodyOf(calls[0]!)).toEqual({ a: 1 });
  });

  it('resolves 204 to undefined and sends no body for GET', async () => {
    respond = () => new Response(null, { status: 204 });
    await expect(requestJson('DELETE', '/layouts/a')).resolves.toBeUndefined();
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('throws ApiError with detail, message of object details, and the body', async () => {
    respond = () => json({ detail: 'layout not found: a' }, 404);
    await expect(requestJson('GET', '/layouts/a')).rejects.toMatchObject({
      status: 404,
      message: 'layout not found: a',
    });
    const detail = { message: 'changed elsewhere', current: { id: 'a', revision: 3 } };
    respond = () => json({ detail }, 409);
    const err = await requestJson('PUT', '/layouts/a', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('changed elsewhere');
    expect((err as ApiError).body).toEqual({ detail });
  });

  it('maps network failures to status 0', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));
    await expect(requestJson('GET', '/settings')).rejects.toMatchObject({ status: 0 });
  });
});

describe('persistence endpoints', () => {
  it('builds paths, methods and bodies', async () => {
    respond = () => json({ id: 'a b', revision: 2 });
    await saveLayout('a b', { state: { x: 1 }, revision: 1 });
    expect(calls[0]!.url).toBe('/api/layouts/a%20b');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(bodyOf(calls[0]!)).toEqual({ state: { x: 1 }, revision: 1 });

    respond = () => json({ drawings: [{ id: 'd1' }] });
    expect(await getDrawings({ symbol: 'AAPL', synced: false })).toEqual([{ id: 'd1' }]);
    expect(calls[1]!.url).toBe('/api/drawings?symbol=AAPL&synced=false');
    await getDrawings();
    expect(calls[2]!.url).toBe('/api/drawings');

    respond = () => json({ drawings: [], deleted: ['d2'] });
    await batchDrawings({ upserts: [{ drawing: { id: 'd1' }, baseRevision: 1 }], deletes: [{ id: 'd2' }] });
    expect(calls[3]!.url).toBe('/api/drawings/batch');
    expect(calls[3]!.init.method).toBe('POST');

    respond = () => json({ mode: 'replace', dryRun: true });
    await importAll({ version: 1, app: 'tickerglass' }, { mode: 'replace', dryRun: true });
    expect(calls[4]!.url).toBe('/api/import?mode=replace&dryRun=true');

    await importLayout({ version: 1, kind: 'layout', layout: { name: 'n', state: {}, schemaVersion: 1 } });
    expect(calls[5]!.url).toBe('/api/layouts/import');

    // A real replace carries the explicit confirmation; merge never does.
    await importAll({ version: 1, app: 'tickerglass' }, { mode: 'replace', confirm: true });
    expect(calls[6]!.url).toBe('/api/import?mode=replace&confirm=true');
    await importAll({ version: 1, app: 'tickerglass' }, { mode: 'merge', confirm: true });
    expect(calls[7]!.url).toBe('/api/import?mode=merge');

    respond = () => json({ a: 1 });
    await patchSettings({ a: 1, b: null });
    expect(calls[8]!.init.method).toBe('PATCH');
    expect(bodyOf(calls[8]!)).toEqual({ a: 1, b: null });

    respond = () => json(null);
    expect(await getLastUsedLayout()).toBeNull();
  });

  it('reads conflict bodies', () => {
    const layout = { id: 'a', revision: 3 };
    const lay = new ApiError('x', 409, { detail: { message: 'x', current: layout } });
    expect(isConflict(lay)).toBe(true);
    expect(layoutConflict(lay)).toEqual(layout);
    expect(noteConflict(lay)).toEqual(layout);
    expect(drawingConflicts(lay)).toBeNull();

    const conflicts = [{ id: 'd1', revision: null, drawing: null }];
    const drw = new ApiError('x', 409, { detail: { message: 'x', conflicts } });
    expect(drawingConflicts(drw)).toEqual(conflicts);

    const notFound = new ApiError('x', 404, { detail: { current: layout } });
    expect(isConflict(notFound)).toBe(false);
    expect(layoutConflict(notFound)).toBeNull();
    expect(layoutConflict(new Error('x'))).toBeNull();
    expect(drawingConflicts(new ApiError('name taken', 409, { detail: 'name taken' }))).toBeNull();
  });
});

/** Promise whose resolution the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeDoc = () =>
  Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });

describe('createAutosaver', () => {
  beforeEach(() => vi.useFakeTimers());

  it('debounces to the latest value', async () => {
    const saved: number[] = [];
    const s = createAutosaver<number>(async (v) => void saved.push(v), {
      delay: 100,
      window: new EventTarget(),
      document: fakeDoc(),
    });
    s.schedule(1);
    await vi.advanceTimersByTimeAsync(50);
    s.schedule(2);
    s.schedule(3);
    expect(s.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([3]);
    expect(s.pending).toBe(false);
  });

  it('never overlaps saves and saves the value scheduled during one afterwards', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const saved: string[] = [];
    let inFlight = 0;
    const s = createAutosaver<string>(
      async (v) => {
        inFlight++;
        expect(inFlight).toBe(1);
        const g = deferred();
        gates.push(g);
        await g.promise;
        saved.push(v);
        inFlight--;
      },
      { delay: 10, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule('a');
    await vi.advanceTimersByTimeAsync(10);
    expect(s.saving).toBe(true);
    s.schedule('b');
    await vi.advanceTimersByTimeAsync(10);
    expect(gates).toHaveLength(1);
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(gates).toHaveLength(2);
    gates[1]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(['a', 'b']);
  });

  it('flushes with keepalive on pagehide, normally when the document is hidden', async () => {
    const ctxs: boolean[] = [];
    const recovered: number[] = [];
    const win = new EventTarget();
    const doc = fakeDoc();
    const s = createAutosaver<number>(async (_v, ctx) => void ctxs.push(ctx.keepalive), {
      delay: 10_000,
      window: win,
      document: doc,
      onHide: (v) => recovered.push(v),
    });
    s.schedule(1);
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxs).toEqual([true]);

    s.schedule(2);
    doc.dispatchEvent(new Event('visibilitychange')); // still visible: nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxs).toEqual([true]);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctxs).toEqual([true, false]);
    // A recovery copy of the pending value is offered before each hide flush.
    expect(recovered).toEqual([1, 2]);

    // Nothing pending: no save. After dispose, events are ignored.
    await s.flush();
    s.schedule(3);
    await s.dispose();
    expect(ctxs).toEqual([true, false, false]);
    s.schedule(4);
    s.cancel();
    win.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctxs).toHaveLength(3);
  });

  it('reports conflicts and drops the value', async () => {
    const onConflict = vi.fn();
    const onError = vi.fn();
    const s = createAutosaver<number>(
      () => Promise.reject(new ApiError('changed', 409, { detail: { current: {} } })),
      { delay: 10, onConflict, onError, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule(7);
    await vi.advanceTimersByTimeAsync(10);
    expect(onConflict).toHaveBeenCalledOnce();
    expect(onConflict.mock.calls[0]![1]).toBe(7);
    expect(onError).not.toHaveBeenCalled();
    expect(s.pending).toBe(false);
  });

  it('keeps the value after other errors and retries', async () => {
    let fail = true;
    const saved: number[] = [];
    const onError = vi.fn();
    const s = createAutosaver<number>(
      async (v) => {
        if (fail) throw new ApiError('Network error: API unreachable', 0);
        saved.push(v);
      },
      { delay: 10, retryDelay: 1000, onError, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.pending).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved).toEqual([1]);
    expect(s.pending).toBe(false);
  });

  it('drops the value after a permanent error (4xx) without retrying', async () => {
    const attempts: number[] = [];
    const onError = vi.fn();
    const s = createAutosaver<number>(
      async (v) => {
        attempts.push(v);
        throw new ApiError('too large', 422);
      },
      { delay: 10, retryDelay: 100, onError, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual([1]);
  });

  it('backs off on retryable errors (5xx, 408, 429) and stops after dispose', async () => {
    const at: number[] = [];
    const statuses = [503, 429, 408];
    const s = createAutosaver<number>(
      async () => {
        at.push(Date.now());
        throw new ApiError('busy', statuses[at.length - 1] ?? 500);
      },
      { delay: 0, retryDelay: 100, window: new EventTarget(), document: fakeDoc() },
    );
    const t0 = Date.now();
    s.schedule(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100); // 1st retry after 100
    await vi.advanceTimersByTimeAsync(200); // 2nd after 200
    expect(at.map((t) => t - t0)).toEqual([0, 100, 300]);
    expect(s.pending).toBe(true);
    await s.dispose(); // final attempt, then no more retries
    const n = at.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(at).toHaveLength(n);
  });

  it('a newer value wins over a failed one', async () => {
    const gate = deferred();
    const saved: number[] = [];
    let first = true;
    const s = createAutosaver<number>(
      async (v) => {
        if (first) {
          first = false;
          await gate.promise;
        }
        saved.push(v);
      },
      { delay: 10, retryDelay: 0, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule(1);
    await vi.advanceTimersByTimeAsync(10);
    s.schedule(2);
    gate.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(10);
    expect(saved).toEqual([2]);
  });
});

describe('requestJson keepalive', () => {
  it('uses keepalive only for bodies under 60 KB', async () => {
    respond = () => json({});
    await requestJson('PUT', '/x', { s: 'a'.repeat(100) }, { keepalive: true });
    await requestJson('PUT', '/x', { s: 'a'.repeat(70_000) }, { keepalive: true });
    expect(calls[0]!.init.keepalive).toBe(true);
    expect(calls[1]!.init.keepalive).toBeUndefined();
    expect(String(calls[1]!.init.body)).toHaveLength(70_000 + 8);
  });
});

describe('createLayoutAutosaver', () => {
  beforeEach(() => vi.useFakeTimers());

  it('advances the revision and resolves conflicts via setRevision', async () => {
    let serverRev = 4;
    respond = (c) => {
      const b = bodyOf(c);
      if (b.revision !== serverRev)
        return json({ detail: { message: 'x', current: { id: 'L', revision: serverRev } } }, 409);
      serverRev++;
      return json({ id: 'L', revision: serverRev, state: b.state });
    };
    const onSaved = vi.fn();
    const onConflict = vi.fn();
    const s = createLayoutAutosaver<{ n: number }>(
      { id: 'L', revision: 4 },
      { delay: 10, schemaVersion: 2, onSaved, onConflict, window: new EventTarget(), document: fakeDoc() },
    );
    s.schedule({ n: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.revision).toBe(5);
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ revision: 5 });
    expect(bodyOf(calls[0]!)).toEqual({ state: { n: 1 }, revision: 4, schemaVersion: 2 });

    serverRev = 9; // another device saved
    s.schedule({ n: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(onConflict).toHaveBeenCalledOnce();
    const server = layoutConflict(onConflict.mock.calls[0]![0]);
    expect(server?.revision).toBe(9);

    // Keep mine: rebase on the server revision and save again.
    s.setRevision(server!.revision);
    s.schedule({ n: 2 });
    await s.flush();
    expect(s.revision).toBe(10);
    expect(calls.at(-1)!.init.keepalive).toBeUndefined();
  });
});

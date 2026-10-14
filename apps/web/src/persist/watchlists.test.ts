import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Flag, Watchlist } from '../api/types';
import { useAppStore } from '../store/app';
import { useWatchlistStore } from '../watchlist/store';
import type { FlagColor, WatchlistEntry, WatchlistItem } from '../watchlist/types';
import { WatchlistSync, type WatchlistsApi } from './watchlists';

const conflict = (current: Watchlist) =>
  new ApiError('conflict', 409, { detail: { message: 'stale', current } });
const notFound = () => new ApiError('not found', 404, { detail: 'not found' });
const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const wl = (
  id: string,
  name: string,
  revision: number,
  items: WatchlistItem[] = [],
): Watchlist => ({
  id,
  name,
  items,
  revision,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const entry = (o: Partial<WatchlistEntry> & { id: string }): WatchlistEntry => ({
  name: o.id,
  items: [],
  revision: 1,
  dirty: false,
  ...o,
});
const flag = (symbol: string, color: FlagColor, at = '2026-01-01T00:00:00Z'): Flag => ({
  symbol,
  color,
  createdAt: at,
  updatedAt: at,
});

const st = () => useWatchlistStore.getState();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
/** Let pending promise chains run (no timers: those would start autosaves). */
async function settle(cond: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve();
}

/** In-memory server with the documented semantics. */
function makeServer() {
  const lists = new Map<string, Watchlist>();
  const flags = new Map<string, Flag>();
  const server = {
    lists,
    flags,
    down: false,
    calls: [] as string[],
    api: {
      listWatchlists: vi.fn(async () => {
        if (server.down) throw new TypeError('offline');
        return [...lists.values()];
      }),
      getFlags: vi.fn(async () => {
        if (server.down) throw new TypeError('offline');
        return [...flags.values()];
      }),
      createWatchlist: vi.fn(async (b: { id?: string; name: string; items: WatchlistItem[] }) => {
        if (server.down) throw new TypeError('offline');
        server.calls.push(`POST ${b.id}`);
        const cur = b.id ? lists.get(b.id) : undefined;
        if (cur) throw conflict(cur);
        const w = wl(b.id ?? 'gen', b.name, 1, b.items);
        lists.set(w.id, w);
        return w;
      }),
      updateWatchlist: vi.fn(
        async (id: string, b: { name: string; items: WatchlistItem[]; revision?: number }) => {
          if (server.down) throw new TypeError('offline');
          server.calls.push(`PUT ${id}@${b.revision}`);
          const cur = lists.get(id);
          if (!cur) throw notFound();
          if (b.revision !== undefined && b.revision !== cur.revision) throw conflict(cur);
          const w = { ...cur, name: b.name, items: b.items, revision: cur.revision + 1 };
          lists.set(id, w);
          return w;
        },
      ),
      deleteWatchlist: vi.fn(async (id: string) => {
        if (server.down) throw new TypeError('offline');
        server.calls.push(`DELETE ${id}`);
        if (!lists.delete(id)) throw notFound();
      }),
      patchFlags: vi.fn(async (patch: Record<string, FlagColor | null>) => {
        if (server.down) throw new TypeError('offline');
        for (const [sym, c] of Object.entries(patch)) {
          if (c === null) flags.delete(sym);
          else if (flags.get(sym)?.color !== c)
            flags.set(sym, flag(sym, c, '2026-02-01T00:00:00Z'));
        }
        return [...flags.values()];
      }),
    },
  };
  return server;
}

function setup(server = makeServer()) {
  const onError = vi.fn();
  const onConflict = vi.fn();
  const sync = new WatchlistSync({
    api: server.api as unknown as WatchlistsApi,
    delay: 0,
    retryDelay: 0,
    onError,
    onConflict,
  });
  sync.start();
  return { server, sync, onError, onConflict };
}

beforeEach(() => {
  useWatchlistStore.setState({
    lists: {},
    pendingDeletes: [],
    flags: {},
    flagsDirty: {},
    seeded: false,
    pendingSeed: null,
  });
  useAppStore.setState({ symbol: 'AAPL', recentSymbols: ['MSFT', 'AAPL'] });
});

describe('WatchlistSync.load', () => {
  it('adopts clean lists, keeps dirty ones, handles lists deleted elsewhere', async () => {
    const { server, sync } = setup();
    server.lists.set('a', wl('a', 'A new', 5, [S('X')]));
    server.lists.set('b', wl('b', 'B server', 2));
    server.lists.set('c', wl('c', 'C server', 2));
    useWatchlistStore.setState({
      lists: {
        a: entry({ id: 'a', name: 'A old', revision: 4 }), // clean -> adopt
        b: entry({ id: 'b', name: 'B mine', revision: 2, dirty: true }), // dirty -> keep
        d: entry({ id: 'd', revision: 3 }), // clean, gone on server -> dropped
        e: entry({ id: 'e', revision: 3, dirty: true }), // dirty, gone -> recreated
        f: entry({ id: 'f', revision: null, dirty: true }), // offline-created -> kept
      },
      pendingDeletes: ['c'],
    });
    await sync.load();
    const lists = st().lists;
    expect(lists.a).toMatchObject({ name: 'A new', revision: 5, dirty: false });
    expect(lists.b).toMatchObject({ name: 'B mine', dirty: true });
    expect(lists.d).toBeUndefined();
    expect(lists.e).toMatchObject({ revision: null, dirty: true });
    expect(lists.f).toMatchObject({ revision: null, dirty: true });
    expect(lists.c).toBeUndefined(); // pending delete is not re-added
    await sync.flush();
    expect(server.lists.has('c')).toBe(false);
    expect(server.lists.get('b')).toMatchObject({ name: 'B mine', revision: 3 });
    expect(server.lists.get('e')).toBeDefined();
    expect(server.lists.get('f')).toBeDefined();
    expect(st().pendingDeletes).toEqual([]);
    await sync.dispose();
  });

  it('merges flags: server map overlaid with unsent local flags', async () => {
    const { server, sync } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    server.flags.set('AAPL', flag('AAPL', 'red'));
    server.flags.set('MSFT', flag('MSFT', 'blue'));
    useWatchlistStore.setState({
      flags: { MSFT: { color: 'green', at: 'x' } },
      flagsDirty: { MSFT: true, TSLA: true },
    });
    await sync.load();
    expect(st().flags).toEqual({
      AAPL: { color: 'red', at: '2026-01-01T00:00:00Z' },
      MSFT: { color: 'green', at: 'x' },
    });
    await sync.flush();
    expect(server.api.patchFlags).toHaveBeenCalledWith({ MSFT: 'green', TSLA: null });
    expect(server.flags.get('MSFT')?.color).toBe('green');
    expect(st().flagsDirty).toEqual({});
    expect(st().flags.MSFT?.at).toBe('2026-02-01T00:00:00Z');
    await sync.dispose();
  });

  it('seeds a default list from the current and recent symbols on first run', async () => {
    const { sync, server } = setup();
    await sync.load();
    const [l] = Object.values(st().lists);
    expect(l).toMatchObject({ name: 'Watchlist', revision: null, dirty: true });
    expect(l!.items).toEqual([S('AAPL'), S('MSFT')]);
    await sync.flush();
    expect(server.lists.size).toBe(1);
    await sync.dispose();
  });

  it('seeds only once: deleting the last list does not resurrect the default', async () => {
    const { sync, server } = setup();
    await sync.load();
    await sync.flush();
    const [id] = Object.keys(st().lists);
    st().deleteList(id!);
    await sync.flush();
    expect(server.lists.size).toBe(0);
    await sync.load(); // e.g. tab focus
    expect(st().lists).toEqual({});
    await sync.dispose();
  });

  it('marks existing lists as seeded; a seed drops invalid recent symbols and expressions', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    expect(st().seeded).toBe(true);
    useAppStore.setState({ symbol: 'AAPL/MSFT', recentSymbols: ['A B', 'msft', 'AAPL'] });
    useWatchlistStore.setState({ lists: {}, seeded: false });
    server.lists.clear();
    await sync.load();
    expect(Object.values(st().lists)[0]!.items).toEqual([S('MSFT'), S('AAPL')]);
    await sync.dispose();
  });

  it('seeds offline from an empty cache and pushes once back online', async () => {
    const { sync, server } = setup();
    server.down = true;
    await expect(sync.load()).rejects.toThrow();
    expect(Object.keys(st().lists)).toHaveLength(1);
    // Edits while the API is down.
    const id = Object.keys(st().lists)[0]!;
    st().addSymbols(id, ['NVDA']);
    server.down = false;
    await sync.load();
    await sync.flush();
    expect(server.lists.get(id)!.items).toContainEqual(S('NVDA'));
    expect(st().lists[id]).toMatchObject({ dirty: false, revision: 1 });
    await sync.dispose();
  });

  it('drops an untouched offline seed when the server already has lists', async () => {
    const { sync, server } = setup();
    server.down = true;
    await expect(sync.load()).rejects.toThrow();
    await expect(sync.load()).rejects.toThrow(); // seeds once
    expect(Object.keys(st().lists)).toHaveLength(1);
    expect(st().seeded).toBe(false);
    server.down = false;
    server.lists.set('a', wl('a', 'Watchlist', 1, [S('X')])); // made by another browser
    await sync.load();
    expect(Object.keys(st().lists)).toEqual(['a']);
    expect(st().seeded).toBe(true);
    await sync.flush();
    expect(server.lists.size).toBe(1);
    expect(server.api.createWatchlist).not.toHaveBeenCalled();
    await sync.dispose();
  });

  it('keeps an offline seed that was edited, even when the server has lists', async () => {
    const { sync, server } = setup();
    server.down = true;
    await expect(sync.load()).rejects.toThrow();
    const id = Object.keys(st().lists)[0]!;
    st().addSymbols(id, ['NVDA']);
    server.down = false;
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    await sync.flush();
    expect(server.lists.get(id)!.items).toContainEqual(S('NVDA'));
    expect(st().seeded).toBe(true);
    await sync.dispose();
  });

  it('pushes an untouched offline seed when the server has no lists', async () => {
    const { sync, server } = setup();
    server.down = true;
    await expect(sync.load()).rejects.toThrow();
    const id = Object.keys(st().lists)[0]!;
    server.down = false;
    await sync.load();
    await sync.flush();
    expect([...server.lists.keys()]).toEqual([id]);
    expect(st().seeded).toBe(true);
    await sync.dispose();
  });

  it('an offline seed the user deleted is not re-seeded once online', async () => {
    const { sync, server } = setup();
    server.down = true;
    await expect(sync.load()).rejects.toThrow();
    st().deleteList(Object.keys(st().lists)[0]!);
    server.down = false;
    await sync.load();
    await sync.flush();
    expect(st().lists).toEqual({});
    expect(server.lists.size).toBe(0);
    expect(st().seeded).toBe(true);
    await sync.dispose();
  });
});

describe('WatchlistSync.flush', () => {
  it('creates with the client id, then updates with the base revision', async () => {
    const { sync, server } = setup();
    await sync.load();
    const id = st().createList('Mine', [S('A')]);
    await sync.flush();
    expect(server.api.createWatchlist).toHaveBeenCalledWith({
      id,
      name: 'Mine',
      items: [S('A')],
    });
    st().addSymbols(id, ['B']);
    await sync.flush();
    expect(server.calls.at(-1)).toBe(`PUT ${id}@1`);
    expect(st().lists[id]).toMatchObject({ revision: 2, dirty: false });
    await sync.dispose();
  });

  it('retries a create that returned 409 as a PUT on the current revision', async () => {
    const { sync, server } = setup();
    await sync.load();
    const id = st().createList('Mine', [S('A')]);
    server.lists.set(id, wl(id, 'Mine', 4, [S('OLD')])); // earlier create went through
    await sync.flush();
    expect(server.calls.slice(-2)).toEqual([`POST ${id}`, `PUT ${id}@4`]);
    expect(server.lists.get(id)).toMatchObject({ items: [S('A')], revision: 5 });
    expect(st().lists[id]).toMatchObject({ revision: 5, dirty: false });
    await sync.dispose();
  });

  it('adopts the server copy on 409 and "Keep mine" restores', async () => {
    const { sync, server, onConflict } = setup();
    server.lists.set('a', wl('a', 'A', 1, [S('X')]));
    await sync.load();
    st().addSymbols('a', ['MINE']);
    server.lists.set('a', wl('a', 'Renamed', 7, [S('THEIRS')])); // changed elsewhere
    await sync.flush();
    expect(st().lists.a).toMatchObject({ name: 'Renamed', revision: 7, dirty: false });
    expect(st().lists.a!.items).toEqual([S('THEIRS')]);
    expect(onConflict).toHaveBeenCalledWith('a', 'A', expect.any(Function));
    onConflict.mock.calls[0]![2]();
    expect(st().lists.a).toMatchObject({ name: 'A', revision: 7, dirty: true });
    await sync.flush();
    expect(server.lists.get('a')).toMatchObject({ name: 'A', revision: 8 });
    expect(server.lists.get('a')!.items).toEqual([S('X'), S('MINE')]);
    await sync.dispose();
  });

  it('recreates a list that was deleted elsewhere (404 on PUT)', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    server.lists.delete('a');
    await sync.flush();
    expect(server.lists.get('a')).toMatchObject({ revision: 1, items: [S('X')] });
    expect(st().lists.a).toMatchObject({ revision: 1, dirty: false });
    await sync.dispose();
  });

  it('delete of an already deleted list counts as done', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().deleteList('a');
    server.lists.delete('a');
    await sync.flush();
    expect(st().pendingDeletes).toEqual([]);
    await sync.dispose();
  });

  it('keeps a list dirty when it was edited while saving', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    server.api.updateWatchlist.mockImplementationOnce(async (id, b) => {
      st().addSymbols('a', ['Y']); // typed on while the request is in flight
      const w = { ...server.lists.get(id)!, name: b.name, items: b.items, revision: 2 };
      server.lists.set(id, w);
      return w;
    });
    await sync.flush();
    await sync.flush();
    expect(server.lists.get('a')!.items).toEqual([S('X'), S('Y')]);
    expect(st().lists.a).toMatchObject({ dirty: false, revision: 3 });
    await sync.dispose();
  });

  it('flag dirty-clear race: a flag changed while saving stays dirty', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().setFlag('AAPL', 'red');
    server.api.patchFlags.mockImplementationOnce(async (patch) => {
      st().setFlag('AAPL', 'blue'); // changed while in flight
      for (const [s, c] of Object.entries(patch))
        server.flags.set(s, flag(s, c!, '2026-02-01T00:00:00Z'));
      return [...server.flags.values()];
    });
    await sync.flush();
    expect(st().flagsDirty).toEqual({ AAPL: true });
    expect(st().flags.AAPL?.color).toBe('blue');
    await sync.flush();
    expect(server.flags.get('AAPL')?.color).toBe('blue');
    expect(st().flagsDirty).toEqual({});
    await sync.dispose();
  });

  it('a transient error keeps edits and retries; a permanent one sets rejected + onError', async () => {
    const { sync, server, onError } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    server.down = true;
    await sync.flush().catch(() => undefined);
    expect(st().lists.a!.dirty).toBe(true);
    server.down = false;
    await sync.flush();
    expect(st().lists.a!.dirty).toBe(false);

    server.api.updateWatchlist.mockImplementation(async () => {
      throw new ApiError('bad', 422, { detail: 'invalid symbol' });
    });
    st().addSymbols('a', ['BAD']);
    await sync.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain('could not be saved');
    expect(st().lists.a!.dirty).toBe(true);
    const calls = server.api.updateWatchlist.mock.calls.length;
    await sync.flush();
    expect(server.api.updateWatchlist).toHaveBeenCalledTimes(calls); // rejected: not resent
    await sync.dispose();
  });

  it('a list created and deleted while its create is in flight is deleted on the server', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1)); // not a first run: no seeded list
    await sync.load();
    const id = st().createList('Tmp');
    server.api.createWatchlist.mockImplementationOnce(async (b) => {
      st().deleteList(id); // revision still null: not queued
      const w = wl(id, b.name, 1, b.items);
      server.lists.set(id, w);
      return w;
    });
    await sync.flush();
    expect(st().pendingDeletes).toEqual([id]); // queued once
    await sync.flush();
    expect(server.lists.has(id)).toBe(false);
    expect(server.calls.filter((c) => c === `DELETE ${id}`)).toHaveLength(1);
    await sync.dispose();
  });

  it('a list deleted while its PUT is in flight is queued for deletion once', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    const put = server.api.updateWatchlist.getMockImplementation()!;
    server.api.updateWatchlist.mockImplementationOnce(async (id, b) => {
      st().deleteList('a');
      return put(id, b);
    });
    await sync.flush();
    expect(st().pendingDeletes).toEqual(['a']);
    await sync.flush();
    expect(server.lists.has('a')).toBe(false);
    expect(server.calls.filter((c) => c === 'DELETE a')).toHaveLength(1);
    await sync.dispose();
  });

  it('a list deleted while its PUT gets 404 is not re-created', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    server.api.updateWatchlist.mockImplementationOnce(async () => {
      st().deleteList('a'); // deleted here while the PUT is in flight...
      server.lists.delete('a'); // ...and elsewhere
      throw notFound();
    });
    await sync.flush();
    expect(st().lists.a).toBeUndefined();
    expect(st().pendingDeletes).toEqual(['a']);
    await sync.flush();
    expect(server.lists.has('a')).toBe(false);
    expect(server.api.createWatchlist).not.toHaveBeenCalled();
    expect(st().pendingDeletes).toEqual([]);
    await sync.dispose();
  });

  it('a list deleted while its PUT gets 409 is not resurrected with the server copy', async () => {
    const { sync, server, onConflict } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    server.api.updateWatchlist.mockImplementationOnce(async () => {
      st().deleteList('a');
      server.lists.set('a', wl('a', 'Theirs', 5));
      throw conflict(server.lists.get('a')!);
    });
    await sync.flush();
    expect(st().lists.a).toBeUndefined();
    expect(onConflict).not.toHaveBeenCalled();
    await sync.flush();
    expect(server.lists.has('a')).toBe(false);
    expect(st().pendingDeletes).toEqual([]);
    await sync.dispose();
  });

  it('a list whose create response was lost is deleted on the server when deleted here', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    const id = st().createList('Tmp');
    const post = server.api.createWatchlist.getMockImplementation()!;
    server.api.createWatchlist.mockImplementationOnce(async (b) => {
      await post(b); // went through on the server...
      throw new TypeError('offline'); // ...but the response was lost
    });
    await sync.flush();
    expect(server.lists.has(id)).toBe(true);
    expect(st().lists[id]!.revision).toBeNull();
    st().deleteList(id);
    await sync.flush();
    expect(server.lists.has(id)).toBe(false);
    await sync.load();
    expect(st().lists[id]).toBeUndefined();
    await sync.dispose();
  });
});

describe('WatchlistSync load/flush interleavings', () => {
  it('a create finishing while load() fetches is not dropped as deleted elsewhere', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    const id = st().createList('New', [S('X')]);
    const postGate = deferred();
    const post = server.api.createWatchlist.getMockImplementation()!;
    server.api.createWatchlist.mockImplementationOnce(async (b) => {
      await postGate.promise;
      return post(b);
    });
    const getGate = deferred();
    const get = server.api.listWatchlists.getMockImplementation()!;
    server.api.listWatchlists.mockImplementationOnce(async () => {
      const snapshot = await get(); // taken when the GET is sent
      await getGate.promise;
      return snapshot;
    });
    const flushing = sync.flush();
    await settle(() => server.api.createWatchlist.mock.calls.length === 1);
    const loading = sync.load();
    await settle();
    postGate.resolve();
    await flushing;
    getGate.resolve();
    await loading;
    expect(st().lists[id]).toMatchObject({ revision: 1, dirty: false });
    await sync.dispose();
  });

  it('a PUT finishing while load() fetches is not overwritten by the older server copy', async () => {
    const { sync, server, onConflict } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().addSymbols('a', ['X']);
    const putGate = deferred();
    const put = server.api.updateWatchlist.getMockImplementation()!;
    server.api.updateWatchlist.mockImplementationOnce(async (id, b) => {
      await putGate.promise;
      return put(id, b);
    });
    const getGate = deferred();
    const get = server.api.listWatchlists.getMockImplementation()!;
    server.api.listWatchlists.mockImplementationOnce(async () => {
      const snapshot = await get();
      await getGate.promise;
      return snapshot;
    });
    const flushing = sync.flush();
    await settle(() => server.api.updateWatchlist.mock.calls.length === 1);
    const loading = sync.load();
    await settle();
    putGate.resolve();
    await flushing;
    getGate.resolve();
    await loading;
    expect(st().lists.a).toMatchObject({ revision: 2, dirty: false, items: [S('X')] });
    st().addSymbols('a', ['Y']);
    await sync.flush();
    expect(onConflict).not.toHaveBeenCalled();
    expect(server.lists.get('a')).toMatchObject({ revision: 3, items: [S('X'), S('Y')] });
    await sync.dispose();
  });

  it('a flag PATCH finishing while load() fetches is not reverted', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    st().setFlag('AAPL', 'red');
    const patchGate = deferred();
    const patch = server.api.patchFlags.getMockImplementation()!;
    server.api.patchFlags.mockImplementationOnce(async (p) => {
      await patchGate.promise;
      return patch(p);
    });
    const getGate = deferred();
    const get = server.api.getFlags.getMockImplementation()!;
    server.api.getFlags.mockImplementationOnce(async () => {
      const snapshot = await get();
      await getGate.promise;
      return snapshot;
    });
    const flushing = sync.flush();
    await settle(() => server.api.patchFlags.mock.calls.length === 1);
    const loading = sync.load();
    await settle();
    patchGate.resolve();
    await flushing;
    getGate.resolve();
    await loading;
    expect(st().flags.AAPL?.color).toBe('red');
    await sync.dispose();
  });

  it('coalesces loads queued behind one in flight', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    const getGate = deferred();
    const get = server.api.listWatchlists.getMockImplementation()!;
    server.api.listWatchlists.mockImplementationOnce(async () => {
      await getGate.promise;
      return get();
    });
    const first = sync.load();
    await settle(() => server.api.listWatchlists.mock.calls.length === 2);
    const second = sync.load(); // the first already fetches: queue one more
    const third = sync.load();
    const fourth = sync.load();
    expect(third).toBe(second);
    expect(fourth).toBe(second);
    getGate.resolve();
    await Promise.all([first, second, third, fourth]);
    expect(server.api.listWatchlists).toHaveBeenCalledTimes(3);
    await sync.dispose();
  });

  it('a flush runs ahead of a queued load, but never during a GET', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'A', 1));
    await sync.load();
    const getGate = deferred();
    const get = server.api.listWatchlists.getMockImplementation()!;
    server.api.listWatchlists.mockImplementation(async () => {
      server.calls.push('GET');
      if (server.calls.filter((c) => c === 'GET').length === 1) await getGate.promise;
      return get();
    });
    const loading = sync.load(); // in flight
    await settle(() => server.calls.includes('GET'));
    const queued = sync.load(); // waits
    st().addSymbols('a', ['X']);
    const flushing = sync.flush();
    await settle();
    expect(server.calls).toEqual(['GET']); // no PUT while the GET is in flight
    getGate.resolve();
    await Promise.all([loading, queued, flushing]);
    expect(server.calls).toEqual(['GET', 'PUT a@1', 'GET']);
    expect(st().lists.a).toMatchObject({ revision: 2, dirty: false, items: [S('X')] });
    await sync.dispose();
  });

  it('never adopts a server copy older than the local revision', async () => {
    const { sync, server } = setup();
    server.lists.set('a', wl('a', 'Old', 3));
    useWatchlistStore.setState({ lists: { a: entry({ id: 'a', name: 'New', revision: 5 }) } });
    await sync.load();
    expect(st().lists.a).toMatchObject({ name: 'New', revision: 5 });
    await sync.dispose();
  });
});

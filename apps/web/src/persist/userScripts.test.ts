import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { UserScript } from '../api/types';
import { useScriptsStore } from '../scripts/store';
import { safeStorage } from './net';
import { USER_SCRIPTS_CACHE_KEY, UserScriptConflict, UserScriptsSync } from './userScripts';

const script = (id: string, o: Partial<UserScript> = {}): UserScript => ({
  id,
  name: id,
  source: 'src',
  manifest: null,
  apiVersion: 1,
  revision: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...o,
});
const input = { name: 'n', source: 's', manifest: null, apiVersion: 1 };
const conflict = (current: UserScript) =>
  new ApiError('conflict', 409, { detail: { message: 'stale', current } });

function setup() {
  const data = new Map<string, string>();
  const storage = safeStorage({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  });
  const api = {
    listUserScripts: vi.fn(async () => [] as UserScript[]),
    createUserScript: vi.fn(async (b: { id: string }) => script(b.id)),
    updateUserScript: vi.fn(async (id: string) => script(id, { revision: 2 })),
    deleteUserScript: vi.fn(async () => undefined),
  };
  return { data, sync: new UserScriptsSync({ api, storage }), api };
}
const cached = (data: Map<string, string>) =>
  JSON.parse(data.get(USER_SCRIPTS_CACHE_KEY) ?? 'null');

beforeEach(() => useScriptsStore.setState({ scripts: [], loaded: false }));

describe('load and cache', () => {
  it('adopts the server list and caches it', async () => {
    const { sync, api, data } = setup();
    api.listUserScripts.mockResolvedValue([script('a'), script('b')]);
    await sync.load();
    expect(useScriptsStore.getState().scripts.map((s) => s.id)).toEqual(['a', 'b']);
    expect(useScriptsStore.getState().loaded).toBe(true);
    expect(cached(data)).toHaveLength(2);
  });

  it('shows the cached copy and keeps it when the API is down', async () => {
    const { sync, api, data } = setup();
    data.set(USER_SCRIPTS_CACHE_KEY, JSON.stringify([script('a'), { junk: 1 }]));
    sync.loadCache();
    expect(useScriptsStore.getState().scripts.map((s) => s.id)).toEqual(['a']);
    api.listUserScripts.mockRejectedValue(new ApiError('down', 503, null));
    await expect(sync.load()).rejects.toBeInstanceOf(ApiError);
    expect(useScriptsStore.getState().scripts).toHaveLength(1);
    expect(cached(data)).toHaveLength(2); // the cache file is left as it was
  });

  it('an empty cache entry is a known (empty) list', () => {
    const { sync, data } = setup();
    data.set(USER_SCRIPTS_CACHE_KEY, '[]');
    sync.loadCache();
    expect(useScriptsStore.getState()).toMatchObject({ scripts: [], loaded: true });
  });

  it('a missing or corrupt cache leaves the store unloaded until the API answers', async () => {
    const { sync, api, data } = setup();
    sync.loadCache();
    expect(useScriptsStore.getState()).toMatchObject({ scripts: [], loaded: false });
    data.set(USER_SCRIPTS_CACHE_KEY, '{nope');
    sync.loadCache();
    expect(useScriptsStore.getState().loaded).toBe(false);
    api.listUserScripts.mockResolvedValue([script('a')]);
    await sync.load();
    expect(useScriptsStore.getState()).toMatchObject({ loaded: true });
  });

  it('a failed first load without a cache marks the store loaded (scripts show as missing)', async () => {
    const { sync, api } = setup();
    sync.loadCache();
    api.listUserScripts.mockRejectedValue(new ApiError('down', 503, null));
    await expect(sync.load()).rejects.toBeInstanceOf(ApiError);
    expect(useScriptsStore.getState()).toMatchObject({ scripts: [], loaded: true });
  });

  it('settle marks the store loaded without touching scripts', () => {
    const { sync } = setup();
    sync.settle();
    expect(useScriptsStore.getState()).toMatchObject({ scripts: [], loaded: true });
  });
});

describe('save', () => {
  it('creates an unknown script with POST', async () => {
    const { sync, api, data } = setup();
    const saved = await sync.save('a', input);
    expect(api.createUserScript).toHaveBeenCalledWith({ id: 'a', ...input });
    expect(useScriptsStore.getState().scripts).toEqual([saved]);
    expect(cached(data)).toHaveLength(1);
  });

  it('updates a known script with its revision', async () => {
    const { sync, api } = setup();
    useScriptsStore.getState().setScripts([script('a', { revision: 4 })]);
    const saved = await sync.save('a', input);
    expect(api.updateUserScript).toHaveBeenCalledWith('a', { ...input, revision: 4 });
    expect(saved.revision).toBe(2);
    expect(useScriptsStore.getState().scripts[0]!.revision).toBe(2);
  });

  it('surfaces a 409 as UserScriptConflict without touching the store', async () => {
    const { sync, api } = setup();
    useScriptsStore.getState().setScripts([script('a')]);
    const current = script('a', { revision: 9, name: 'theirs' });
    api.updateUserScript.mockRejectedValue(conflict(current));
    const err = await sync.save('a', input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserScriptConflict);
    expect((err as UserScriptConflict).current).toEqual(current);
    expect(useScriptsStore.getState().scripts[0]!.revision).toBe(1);
  });

  it('reports a taken id on create as a conflict', async () => {
    const { sync, api } = setup();
    api.createUserScript.mockRejectedValue(conflict(script('a', { revision: 3 })));
    await expect(sync.save('a', input)).rejects.toBeInstanceOf(UserScriptConflict);
  });

  it('overwrites without a revision', async () => {
    const { sync, api } = setup();
    useScriptsStore.getState().setScripts([script('a')]);
    await sync.save('a', input, { overwrite: true });
    expect(api.updateUserScript).toHaveBeenCalledWith('a', input);
  });

  it('propagates other errors and changes nothing', async () => {
    const { sync, api, data } = setup();
    api.createUserScript.mockRejectedValue(new ApiError('down', 503, null));
    await expect(sync.save('a', input)).rejects.toMatchObject({ status: 503 });
    expect(useScriptsStore.getState().scripts).toEqual([]);
    expect(data.has(USER_SCRIPTS_CACHE_KEY)).toBe(false);
  });
});

describe('delete and adopt', () => {
  it('deletes on the server then locally', async () => {
    const { sync, api, data } = setup();
    useScriptsStore.getState().setScripts([script('a'), script('b')]);
    await sync.delete('a');
    expect(api.deleteUserScript).toHaveBeenCalledWith('a');
    expect(useScriptsStore.getState().scripts.map((s) => s.id)).toEqual(['b']);
    expect(cached(data)).toHaveLength(1);
  });

  it('treats 404 as deleted and keeps the script on other errors', async () => {
    const { sync, api } = setup();
    useScriptsStore.getState().setScripts([script('a')]);
    api.deleteUserScript.mockRejectedValueOnce(new ApiError('nf', 404, null));
    await sync.delete('a');
    expect(useScriptsStore.getState().scripts).toEqual([]);
    useScriptsStore.getState().setScripts([script('a')]);
    api.deleteUserScript.mockRejectedValueOnce(new ApiError('down', 503, null));
    await expect(sync.delete('a')).rejects.toBeInstanceOf(ApiError);
    expect(useScriptsStore.getState().scripts).toHaveLength(1);
  });

  it('adopts a conflict version', () => {
    const { sync } = setup();
    useScriptsStore.getState().setScripts([script('a')]);
    sync.adopt(script('a', { revision: 5 }));
    expect(useScriptsStore.getState().scripts[0]!.revision).toBe(5);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPEED, REPLAY_SPEEDS, useReplayStore } from './store';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('replay store', () => {
  beforeEach(() => {
    useReplayStore.setState({ status: 'off', speed: DEFAULT_SPEED, update: 'auto' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to off at 1 s per step with automatic update', () => {
    const s = useReplayStore.getState();
    expect(s.status).toBe('off');
    expect(s.speed).toBe(1000);
    expect(s.update).toBe('auto');
    expect(REPLAY_SPEEDS).toEqual([3000, 1000, 500, 300, 100, 30]);
  });

  it('persists only speed and update', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    useReplayStore
      .getState()
      .set({ speed: 100, update: '5m', status: 'playing', last: 5, tick: '1m' });
    const saved = JSON.parse(storage.data.get('investopen-replay')!) as {
      state: Record<string, unknown>;
    };
    expect(saved.state).toEqual({ speed: 100, update: '5m' });
  });

  it('restores saved values and rejects invalid ones', async () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        'investopen-replay': JSON.stringify({ state: { speed: 300, update: 'bars' }, version: 0 }),
      }),
    );
    await useReplayStore.persist.rehydrate();
    expect(useReplayStore.getState()).toMatchObject({ speed: 300, update: 'bars', status: 'off' });

    vi.stubGlobal(
      'localStorage',
      memoryStorage({
        'investopen-replay': JSON.stringify({ state: { speed: 12345, update: 7 }, version: 0 }),
      }),
    );
    useReplayStore.setState({ speed: 500, update: 'auto' });
    await useReplayStore.persist.rehydrate();
    expect(useReplayStore.getState()).toMatchObject({ speed: 500, update: 'auto' });
  });
});

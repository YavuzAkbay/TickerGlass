import { describe, expect, it } from 'vitest';
import { singleFlight } from './singleFlight';

describe('singleFlight', () => {
  it('ignores calls while one is in flight, then allows the next', async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const run = singleFlight(() => {
      calls++;
      return new Promise<string>((r) => (release = r));
    });
    const first = run();
    expect(await run()).toBeUndefined();
    expect(calls).toBe(1);
    release('a');
    expect(await first).toBe('a');
    const second = run();
    release('b');
    expect(await second).toBe('b');
    expect(calls).toBe(2);
  });

  it('releases after a rejection', async () => {
    let n = 0;
    const run = singleFlight(async () => {
      if (n++ === 0) throw new Error('boom');
      return 'ok';
    });
    await expect(run()).rejects.toThrow('boom');
    expect(await run()).toBe('ok');
  });
});

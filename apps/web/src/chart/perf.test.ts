import '@tickerglass/indicators';
import { describe, expect, it } from 'vitest';
import type { FromWorker } from '../indicators/protocol';
import { WorkerCore } from '../indicators/workerCore';
import { ComputeTimes, perfEnabled } from './perf';

const bars = (n: number) => {
  const time = Float64Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 60);
  const close = Float64Array.from({ length: n }, (_, i) => 100 + Math.sin(i));
  return {
    time,
    open: close.slice(),
    high: close.slice(),
    low: close.slice(),
    close,
    volume: close.slice(),
  };
};

describe('perf', () => {
  it('is enabled by ?perf=1 only', () => {
    expect(perfEnabled('?perf=1')).toBe(true);
    expect(perfEnabled('?a=b&perf=1')).toBe(true);
    expect(perfEnabled('?perf=0')).toBe(false);
    expect(perfEnabled('')).toBe(false);
  });

  it('keeps the last and the mean of recent compute times', () => {
    const t = new ComputeTimes();
    expect(t.stats()).toEqual({ runs: 0, lastMs: 0, avgMs: 0 });
    t.record(2);
    t.record(4);
    expect(t.stats()).toEqual({ runs: 2, lastMs: 4, avgMs: 3 });
    for (let i = 0; i < 100; i++) t.record(1);
    expect(t.stats()).toEqual({ runs: 102, lastMs: 1, avgMs: 1 });
  });

  it('reports worker compute times and measures only while profiling', () => {
    const out: FromWorker[] = [];
    const core = new WorkerCore((m) => out.push(m));
    core.handle({ type: 'add', spec: { id: 's', type: 'sma', inputs: { length: 3 } } });
    core.handle({ type: 'bars', revision: 1, bars: bars(50) });
    const results = () => out.filter((m) => m.type === 'results');
    expect(results().at(-1)).not.toHaveProperty('ms');
    performance.clearMeasures('tickerglass:indicators bars');
    core.handle({ type: 'profile', on: true });
    core.handle({ type: 'bars', revision: 2, bars: bars(50) });
    const last = results().at(-1)!;
    expect(last.ms).toBeGreaterThanOrEqual(0);
    expect(performance.getEntriesByName('tickerglass:indicators bars')).toHaveLength(1);
    performance.clearMeasures('tickerglass:indicators bars');
  });
});

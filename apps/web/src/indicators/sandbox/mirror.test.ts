import type { Bar, BarColumns } from '@investopen/engine';
import { describe, expect, it } from 'vitest';
import { SeriesMirror } from './mirror';

function cols(n: number, base = 100): BarColumns {
  const c = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    c.time[i] = 1000 + i * 60;
    c.open[i] = base + i;
    c.high[i] = base + i + 2;
    c.low[i] = base + i - 2;
    c.close[i] = base + i + 1;
    c.volume[i] = 10 + i;
  }
  return c;
}

const bar = (time: number, close: number): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

describe('SeriesMirror', () => {
  it('starts empty and invalid', () => {
    const m = new SeriesMirror();
    expect(m.valid).toBe(false);
    expect(m.length).toBe(0);
    expect(m.copyColumns().time).toHaveLength(0);
  });

  it('reset copies the bars, independent of the source buffers', () => {
    const m = new SeriesMirror();
    const src = cols(5);
    m.reset(3, src);
    // The source is transferred (detached) right after; the mirror must not share it.
    structuredClone(src, { transfer: [src.time.buffer, src.close.buffer] });
    expect(src.time.length).toBe(0);
    expect(m.valid).toBe(true);
    expect(m.revision).toBe(3);
    expect(m.length).toBe(5);
    const out = m.copyColumns();
    expect([...out.time]).toEqual([1000, 1060, 1120, 1180, 1240]);
    expect([...out.close]).toEqual([101, 102, 103, 104, 105]);
  });

  it('bar updates an existing index and appends at the end', () => {
    const m = new SeriesMirror();
    m.reset(1, cols(3));
    expect(m.apply(1, 2, bar(1120, 50))).toBe(true);
    expect(m.apply(1, 3, bar(1180, 60))).toBe(true);
    expect(m.apply(1, 0, bar(1000, 40))).toBe(true);
    expect(m.length).toBe(4);
    const out = m.copyColumns();
    expect([...out.close]).toEqual([40, 102, 50, 60]);
    expect([...out.time]).toEqual([1000, 1060, 1120, 1180]);
    expect(m.valid).toBe(true);
  });

  it('appends past the initial capacity', () => {
    const m = new SeriesMirror();
    m.reset(0, cols(2));
    for (let i = 2; i < 300; i++) expect(m.apply(0, i, bar(1000 + i * 60, i))).toBe(true);
    const out = m.copyColumns();
    expect(out.close.length).toBe(300);
    expect(out.close[299]).toBe(299);
    expect(out.close[1]).toBe(102);
  });

  it('an index gap or another revision marks it dirty until the next reset', () => {
    const m = new SeriesMirror();
    m.reset(1, cols(3));
    expect(m.apply(1, 5, bar(2000, 1))).toBe(false);
    expect(m.dirty).toBe(true);
    expect(m.valid).toBe(false);
    // Stays dirty: even a fitting bar does not repair it.
    expect(m.apply(1, 3, bar(1180, 1))).toBe(false);
    expect(m.length).toBe(3);
    m.reset(2, cols(4));
    expect(m.valid).toBe(true);
    expect(m.apply(1, 4, bar(1240, 1))).toBe(false);
    expect(m.dirty).toBe(true);
    m.reset(3, cols(1));
    expect(m.apply(3, -1, bar(1, 1))).toBe(false);
    m.reset(3, cols(1));
    expect(m.apply(3, 0.5, bar(1, 1))).toBe(false);
  });

  it('copyColumns returns exact-length fresh arrays every call', () => {
    const m = new SeriesMirror();
    m.reset(0, cols(3));
    const a = m.copyColumns();
    const b = m.copyColumns();
    expect(a.time.buffer.byteLength).toBe(3 * 8);
    expect(a.time).not.toBe(b.time);
    a.close[0] = -1;
    expect(m.copyColumns().close[0]).toBe(101);
  });

  it('clear drops the bars', () => {
    const m = new SeriesMirror();
    m.reset(4, cols(3));
    m.apply(4, 9, bar(1, 1));
    m.clear();
    expect(m.length).toBe(0);
    expect(m.revision).toBe(-1);
    expect(m.dirty).toBe(false);
    expect(m.valid).toBe(false);
  });
});

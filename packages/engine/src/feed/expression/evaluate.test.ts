import { describe, expect, it } from 'vitest';
import { evalBar, evalBarColumns, evalColumns, evalRow, type OhlcLike } from './evaluate';
import { parseSymbolExpression } from './parser';

const ast = (s: string) => parseSymbolExpression(s).ast;
const A: OhlcLike = { open: 10, high: 12, low: 9, close: 11 };
const B: OhlcLike = { open: 5, high: 6, low: 4, close: 5.5 };
const legs = new Map([
  ['A', A],
  ['B', B],
]);

describe('evalRow / evalColumns', () => {
  it('follows precedence', () => {
    const v = (s: string) => (s === 'A' ? 10 : 4);
    expect(evalRow(ast('A - B*2'), v)).toBe(2);
    expect(evalRow(ast('-A/B'), v)).toBe(-2.5);
    expect(evalRow(ast('A - B - 1'), v)).toBe(5);
  });

  it('x/0 and non-finite values give NaN', () => {
    expect(evalRow(ast('A/B'), (s) => (s === 'A' ? 1 : 0))).toBeNaN();
    expect(evalRow(ast('A/B - A/B'), (s) => (s === 'A' ? 1 : 0))).toBeNaN();
    expect(evalRow(ast('A*0'), () => Infinity)).toBeNaN();
    expect(evalRow(ast('A*B'), () => 1e200)).toBeNaN();
  });

  it('columns match rows', () => {
    const cols = new Map([
      ['A', new Float64Array([1, 2, 3, NaN])],
      ['B', new Float64Array([2, 0, 4, 1])],
    ]);
    const out = evalColumns(ast('(A+1)/B'), cols, 4);
    expect([...out]).toEqual([1, NaN, 1, NaN]);
  });

  it('columns throw on a missing leg', () => {
    expect(() => evalColumns(ast('A+C'), new Map([['A', new Float64Array(1)]]), 1)).toThrow();
  });
});

describe('evalBar', () => {
  it('A/B', () => {
    expect(evalBar(ast('A/B'), legs)).toEqual({ open: 2, high: 2.25, low: 2, close: 2 });
  });

  it('(A+B)/2', () => {
    expect(evalBar(ast('(A+B)/2'), legs)).toEqual({ open: 7.5, high: 9, low: 6.5, close: 8.25 });
  });

  it('A - B', () => {
    expect(evalBar(ast('A - B'), legs)).toEqual({ open: 5, high: 6, low: 5, close: 5.5 });
  });

  it('A/(B-B) is null', () => {
    expect(evalBar(ast('A/(B-B)'), legs)).toBeNull();
  });

  it('missing leg is null', () => {
    expect(evalBar(ast('A/C'), legs)).toBeNull();
  });

  it('skips non-finite high/low samples', () => {
    const z = new Map([
      ['A', A],
      ['B', { open: 5, high: 6, low: 0, close: 5.5 }],
    ]);
    expect(evalBar(ast('A/B'), z)).toEqual({ open: 2, high: 2, low: 2, close: 2 });
  });
});

describe('evalBarColumns', () => {
  const cols = (time: number[], o: number[], h: number[], l: number[], c: number[]) => ({
    time: new Float64Array(time),
    open: new Float64Array(o),
    high: new Float64Array(h),
    low: new Float64Array(l),
    close: new Float64Array(c),
  });

  it('evaluates aligned rows, omits missing/invalid rows, volume 0', () => {
    const a = cols(
      [100, 200, 300, 400],
      [10, 10, 10, 10],
      [12, 12, 12, 12],
      [9, 9, 9, 9],
      [11, 11, 11, 11],
    );
    const b = cols([150, 250], [5, 0], [6, 0], [4, 0], [5.5, 0]);
    const out = evalBarColumns(
      ast('A/B'),
      new Map([
        ['A', a],
        ['B', b],
      ]),
      [new Int32Array([0, 1, 2, 3]), new Int32Array([-1, 0, 1, 1])],
      4,
    );
    // Row 0: B missing. Rows 2/3: B priced 0 -> O/C NaN.
    expect([...out.time]).toEqual([200]);
    expect([...out.open]).toEqual([2]);
    expect([...out.high]).toEqual([2.25]);
    expect([...out.low]).toEqual([2]);
    expect([...out.close]).toEqual([2]);
    expect([...out.volume]).toEqual([0]);
  });

  it('forward-filled legs contribute their close as O=H=L=C', () => {
    const a = cols([1, 2, 3], [10, 10, 10], [12, 12, 12], [9, 9, 9], [11, 11, 11]);
    const b = cols([1], [5], [6], [4], [5.5]);
    const out = evalBarColumns(
      ast('A/B'),
      new Map([
        ['A', a],
        ['B', b],
      ]),
      [new Int32Array([0, 1, 2]), new Int32Array([0, 0, 0])],
      3,
    );
    expect([...out.time]).toEqual([1, 2, 3]);
    // Row 0 fresh: as evalBar. Rows 1-2: B = 5.5 flat.
    expect(out.open[0]).toBe(2);
    expect(out.high[0]).toBe(2.25);
    expect(out.open[1]).toBeCloseTo(10 / 5.5, 12);
    expect(out.high[1]).toBeCloseTo(12 / 5.5, 12);
    expect(out.low[1]).toBeCloseTo(9 / 5.5, 12);
    expect(out.close[1]).toBe(2);
    expect(out.close[2]).toBe(2);
  });

  it('matches evalBar row by row', () => {
    const a = cols([1, 2], [10, 20], [12, 22], [9, 19], [11, 21]);
    const b = cols([1, 2], [5, 4], [6, 5], [4, 3], [5.5, 4.5]);
    const e = ast('(A+B)/2 - 2*A/B');
    const out = evalBarColumns(
      e,
      new Map([
        ['A', a],
        ['B', b],
      ]),
      [new Int32Array([0, 1]), new Int32Array([0, 1])],
      2,
    );
    for (let i = 0; i < 2; i++) {
      const bar = (c: typeof a) => ({
        open: c.open[i] as number,
        high: c.high[i] as number,
        low: c.low[i] as number,
        close: c.close[i] as number,
      });
      const want = evalBar(
        e,
        new Map([
          ['A', bar(a)],
          ['B', bar(b)],
        ]),
      );
      expect({
        open: out.open[i],
        high: out.high[i],
        low: out.low[i],
        close: out.close[i],
      }).toEqual(want);
    }
  });
});

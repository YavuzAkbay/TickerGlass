import { describe, expect, it } from 'vitest';
import {
  buildShareLink,
  decodePayload,
  encodePayload,
  fromBase64Url,
  fromShareItems,
  MAX_LINK_PAYLOAD,
  parseShareJson,
  parseSharePayload,
  payloadFromHash,
  payloadFromLink,
  ShareError,
  shareFileText,
  SHARE_HASH_PREFIX,
  symbolCount,
  toBase64Url,
  toShareItems,
  type SharePayload,
  type WatchlistShare,
} from './codec';
import type { ScreenSpec } from '../screener/server/types';

const LIST: WatchlistShare = {
  v: 1,
  type: 'watchlist',
  name: 'Tech & AI',
  items: ['AAPL', 'MSFT', { section: 'Semis' }, 'NVDA', 'BRK-B', '7203.T', 'ES=F', '^GSPC'],
};

const SPEC: ScreenSpec = {
  schemaVersion: 1,
  universe: { kind: 'class', cls: 'stocks' },
  filter: {
    op: 'and',
    rules: [
      { field: 'rsi14', op: '<', value: 30 },
      { field: 'mcap', op: 'between', value: [1e9, 1e12] },
      { field: 'sma50', op: '>', value: { field: 'sma200' } },
      { field: 'close', op: 'abovePct', value: { field: 'sma20', pct: 5 } },
      { field: 'sector', op: 'in', value: ['Technology', 'Energy'] },
      { field: 'newHi52', op: '=', value: true },
      {
        op: 'or',
        rules: [
          { field: 'pe', op: '<', value: 15 },
          { field: 'sector', op: '=', value: 'Utilities' },
        ],
      },
    ],
  },
  sort: { field: 'rsi14', dir: 'asc' },
  columns: ['last', 'rsi14', 'mcap'],
};
const SCREEN: SharePayload = { v: 1, type: 'screen', name: 'Oversold giants', spec: SPEC };

const b64json = (v: unknown): string =>
  toBase64Url(new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)));
const rejects = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ name: 'ShareError', code });
const invalid = (raw: unknown) => expect(() => parseSharePayload(raw)).toThrow(ShareError);

describe('round trips', () => {
  it('watchlist through encode/decode', async () => {
    const { encoded, compressed } = await encodePayload(LIST);
    expect(compressed).toBe(true);
    expect(encoded.startsWith('z.')).toBe(true);
    expect(await decodePayload(encoded)).toEqual(LIST);
  });

  it('screen through encode/decode', async () => {
    const { encoded } = await encodePayload(SCREEN);
    expect(await decodePayload(encoded)).toEqual(SCREEN);
  });

  it('decodes the uncompressed form (no CompressionStream)', async () => {
    const raw = `r.${b64json(LIST)}`;
    expect(await decodePayload(raw)).toEqual(LIST);
  });

  it('falls back to the plain form when compression is unavailable', async () => {
    const real = globalThis.CompressionStream;
    // @ts-expect-error simulate an old browser
    delete globalThis.CompressionStream;
    try {
      const { encoded, compressed } = await encodePayload(LIST);
      expect(compressed).toBe(false);
      expect(encoded.startsWith('r.')).toBe(true);
      expect(await decodePayload(encoded)).toEqual(LIST);
    } finally {
      globalThis.CompressionStream = real;
    }
  });

  it('JSON file text round-trips', () => {
    expect(parseShareJson(shareFileText(LIST))).toEqual(LIST);
    expect(parseShareJson(shareFileText(SCREEN))).toEqual(SCREEN);
  });

  it('keeps unicode names', async () => {
    const p: WatchlistShare = { ...LIST, name: 'Değerli hisseler 📈' };
    expect(await decodePayload((await encodePayload(p)).encoded)).toEqual(p);
  });

  it('list items convert to and from stored items', () => {
    const stored = fromShareItems(LIST.items);
    expect(stored[2]).toMatchObject({ type: 'section', title: 'Semis', collapsed: false });
    expect(toShareItems(stored)).toEqual(LIST.items);
    expect(symbolCount(LIST.items)).toBe(7);
  });
});

describe('links', () => {
  it('puts the payload in the fragment', async () => {
    const l = await buildShareLink(LIST, 'https://tg.example/');
    expect(l.link.startsWith(`https://tg.example/${SHARE_HASH_PREFIX}z.`)).toBe(true);
    expect(l.link.split('#')).toHaveLength(2);
    expect(l.tooLarge).toBe(false);
    const encoded = payloadFromLink(l.link)!;
    expect(encoded.length).toBe(l.length);
    expect(await decodePayload(encoded)).toEqual(LIST);
  });

  it('reads payloads from a hash', () => {
    expect(payloadFromHash('#tg-import=z.abc')).toBe('z.abc');
    expect(payloadFromHash('#other')).toBeNull();
    expect(payloadFromHash('')).toBeNull();
    expect(payloadFromLink('https://x/#tg-import=r.abc ')).toBe('r.abc');
    expect(payloadFromLink('https://x/')).toBeNull();
  });

  it('a 1000-symbol list fits the link cap', async () => {
    const items = Array.from(
      { length: 1000 },
      (_, i) =>
        `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}${i}`,
    );
    const l = await buildShareLink({ v: 1, type: 'watchlist', name: 'Big', items }, '');
    expect(l.tooLarge).toBe(false);
    expect(l.length).toBeLessThanOrEqual(MAX_LINK_PAYLOAD);
  });

  it('flags a link over the cap', async () => {
    // Incompressible: pseudo-random symbols.
    let x = 12345;
    const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
    const items = Array.from({ length: 1000 }, () => {
      let s = '';
      for (let i = 0; i < 28; i++) s += String.fromCharCode(65 + (rnd() % 26));
      return s;
    });
    const l = await buildShareLink({ v: 1, type: 'watchlist', name: 'Huge', items }, '');
    expect(l.length).toBeGreaterThan(MAX_LINK_PAYLOAD);
    expect(l.tooLarge).toBe(true);
  });
});

describe('malicious or broken input', () => {
  it('rejects a payload over the link cap before decoding it', async () => {
    await rejects(decodePayload(`r.${'A'.repeat(MAX_LINK_PAYLOAD)}`), 'too_large');
  });

  it('rejects a decompression bomb', async () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    const cs = new CompressionStream('deflate-raw');
    const w = cs.writable.getWriter();
    void w.write(zeros).then(() => w.close());
    const packed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    expect(packed.length).toBeLessThan(MAX_LINK_PAYLOAD); // would pass the cap by size alone
    await rejects(decodePayload(`z.${toBase64Url(packed)}`), 'too_large');
  });

  it('rejects bad base64 and unknown formats', async () => {
    await rejects(decodePayload('z.@@@@'), 'bad_encoding');
    await rejects(decodePayload('r.ab+/=='), 'bad_encoding');
    await rejects(decodePayload('r.a'), 'bad_encoding'); // impossible length
    await rejects(decodePayload('x.abcd'), 'bad_encoding');
    await rejects(decodePayload(''), 'bad_encoding');
    await rejects(decodePayload('abcd'), 'bad_encoding');
    expect(() => fromBase64Url('a b')).toThrow(ShareError);
  });

  it('rejects garbage that is not deflate or not JSON', async () => {
    await rejects(
      decodePayload(`z.${toBase64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))}`),
      'bad_encoding',
    );
    await rejects(decodePayload(`r.${b64json('not json')}`), 'bad_json');
    await rejects(
      decodePayload(`r.${toBase64Url(new Uint8Array([0xff, 0xfe, 0xfd]))}`),
      'bad_json',
    );
  });

  it('rejects other versions and types', async () => {
    await rejects(decodePayload(`r.${b64json({ ...LIST, v: 2 })}`), 'unsupported_version');
    await rejects(decodePayload(`r.${b64json({ ...LIST, v: '1' })}`), 'unsupported_version');
    await rejects(decodePayload(`r.${b64json({ ...LIST, type: 'layout' })}`), 'unsupported_type');
  });

  it('does not pollute prototypes and drops unknown fields', async () => {
    const evil =
      '{"v":1,"type":"watchlist","name":"x","items":["AAPL"],"__proto__":{"polluted":true},' +
      '"constructor":{"prototype":{"polluted":true}},"extra":1}';
    const p = await decodePayload(`r.${b64json(evil)}`);
    expect(p).toEqual({ v: 1, type: 'watchlist', name: 'x', items: ['AAPL'] });
    expect(Object.keys(p)).toEqual(['v', 'type', 'name', 'items']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not pollute through a screen spec', () => {
    const spec = JSON.parse(
      '{"schemaVersion":1,"universe":{"kind":"class","cls":"stocks","__proto__":{"x":1}},' +
        '"filter":{"op":"and","rules":[{"field":"rsi14","op":"<","value":30,"__proto__":{"y":1}}],"__proto__":{"z":1}},' +
        '"sort":{"field":"rsi14","dir":"asc","constructor":"bad"},"__proto__":{"w":1}}',
    );
    const p = parseSharePayload({ v: 1, type: 'screen', name: 's', spec });
    expect(JSON.stringify(p)).toBe(
      JSON.stringify({
        v: 1,
        type: 'screen',
        name: 's',
        spec: {
          schemaVersion: 1,
          universe: { kind: 'class', cls: 'stocks' },
          filter: { op: 'and', rules: [{ field: 'rsi14', op: '<', value: 30 }] },
          sort: { field: 'rsi14', dir: 'asc' },
        },
      }),
    );
    for (const k of ['x', 'y', 'z', 'w'])
      expect(({} as Record<string, unknown>)[k]).toBeUndefined();
  });

  it('ignores inherited properties', () => {
    invalid(Object.create({ v: 1, type: 'watchlist', name: 'x', items: [] }));
    const o = Object.create({ items: ['AAPL'] }) as Record<string, unknown>;
    Object.assign(o, { v: 1, type: 'watchlist', name: 'x' });
    invalid(o);
  });

  it('rejects what is not an object', () => {
    for (const raw of [null, undefined, 1, 'x', [], [LIST], true]) invalid(raw);
  });

  it('validates names', () => {
    const base = { v: 1, type: 'watchlist', items: [] };
    invalid({ ...base });
    invalid({ ...base, name: 1 });
    invalid({ ...base, name: '   ' });
    invalid({ ...base, name: 'x'.repeat(201) });
    expect(
      (
        parseSharePayload({
          ...base,
          name: 'a\u202Eb\u2066c\u2069d\u200Fe\u200Ef',
        }) as WatchlistShare
      ).name,
    ).toBe('abcdef');
    expect((parseSharePayload({ ...base, name: ' a\u0000b\n ' }) as WatchlistShare).name).toBe(
      'a b',
    );
    expect(
      (parseSharePayload({ ...base, name: 'x'.repeat(200) }) as WatchlistShare).name,
    ).toHaveLength(200);
  });

  it('validates items', () => {
    const mk = (items: unknown) => ({ v: 1, type: 'watchlist', name: 'x', items });
    invalid(mk('AAPL'));
    invalid(mk([1]));
    invalid(mk([null]));
    invalid(mk([['AAPL']]));
    invalid(mk(['aapl'])); // lower case is not a stored symbol
    invalid(mk(['A B']));
    invalid(mk(['<script>']));
    invalid(mk(['A'.repeat(33)]));
    invalid(mk([{ section: '' }]));
    invalid(mk([{ section: 3 }]));
    invalid(mk([{ section: 'x'.repeat(101) }]));
    invalid(mk([{}]));
    invalid(mk(Array.from({ length: 1001 }, (_, i) => `S${i}`)));
    expect(parseSharePayload(mk(Array.from({ length: 1000 }, (_, i) => `S${i}`)))).toBeTruthy();
    expect((parseSharePayload(mk(['AAPL', 'AAPL', 'MSFT'])) as WatchlistShare).items).toEqual([
      'AAPL',
      'MSFT',
    ]);
  });

  it('rejects an oversized JSON file', () => {
    expect(() => parseShareJson(' '.repeat(300 * 1024))).toThrow(ShareError);
    expect(() => parseShareJson('{')).toThrow(ShareError);
  });
});

describe('screen specs', () => {
  const mk = (patch: Record<string, unknown>) => ({
    v: 1,
    type: 'screen',
    name: 's',
    spec: { ...SPEC, ...patch },
  });
  const rule = (r: unknown) => mk({ filter: { op: 'and', rules: [r] } });

  it('accepts every universe kind that travels', () => {
    for (const universe of [
      { kind: 'class', cls: 'crypto' },
      { kind: 'list', id: 'sp500' },
      { kind: 'symbols', symbols: ['AAPL', 'MSFT'] },
    ])
      expect((parseSharePayload(mk({ universe })) as { spec: ScreenSpec }).spec.universe).toEqual(
        universe,
      );
    expect(parseSharePayload(mk({ filter: null }))).toBeTruthy();
  });

  it('rejects bad universes', () => {
    for (const universe of [
      { kind: 'watchlist', id: 'wl-1' }, // a local id means nothing elsewhere
      { kind: 'class', cls: 'bonds' },
      { kind: 'class' },
      { kind: 'list', id: '../etc' },
      { kind: 'list', id: '' },
      { kind: 'symbols', symbols: ['bad symbol'] },
      { kind: 'symbols', symbols: Array.from({ length: 1001 }, (_, i) => `S${i}`) },
      { kind: 'symbols', symbols: 'AAPL' },
      { kind: 'other' },
      null,
      'stocks',
    ])
      invalid(mk({ universe }));
  });

  it('rejects bad rules instead of dropping them (dropping widens a screen)', () => {
    invalid(rule({ field: 'rsi14', op: 'LIKE', value: 1 }));
    invalid(rule({ field: 'rsi14', op: '<' }));
    invalid(rule({ field: 'rsi 14', op: '<', value: 1 }));
    invalid(rule({ field: '__proto__x', op: '<', value: 1 }));
    invalid(rule({ field: 'rsi14', op: '<', value: Infinity }));
    invalid(rule({ field: 'rsi14', op: '<', value: null }));
    invalid(rule({ field: 'rsi14', op: '<', value: { nope: 1 } }));
    invalid(rule({ field: 'rsi14', op: 'in', value: [1, 2, 3] }));
    invalid(rule({ field: 'rsi14', op: 'in', value: Array.from({ length: 201 }, () => 'x') }));
    invalid(rule({ field: 'rsi14', op: '=', value: 'x'.repeat(201) }));
    invalid(rule('rsi14 < 30'));
    invalid(mk({ filter: { op: 'xor', rules: [] } }));
    invalid(mk({ filter: { field: 'rsi14', op: '<', value: 1 } })); // not a group
  });

  it('caps depth and rule count', () => {
    const leaf = { field: 'rsi14', op: '<', value: 1 };
    const deep = { op: 'and', rules: [{ op: 'or', rules: [{ op: 'and', rules: [leaf] }] }] };
    invalid(mk({ filter: deep }));
    const two = { op: 'and', rules: [{ op: 'or', rules: [leaf] }] };
    expect(parseSharePayload(mk({ filter: two }))).toBeTruthy();
    invalid(mk({ filter: { op: 'and', rules: Array.from({ length: 51 }, () => leaf) } }));
    expect(
      parseSharePayload(
        mk({ filter: { op: 'and', rules: Array.from({ length: 50 }, () => leaf) } }),
      ),
    ).toBeTruthy();
  });

  it('validates sort and columns', () => {
    invalid(mk({ sort: { field: 'rsi14', dir: 'up' } }));
    invalid(mk({ sort: { field: '', dir: 'asc' } }));
    invalid(mk({ sort: null }));
    invalid(mk({ columns: 'last' }));
    invalid(mk({ columns: ['ok', 3] }));
    invalid(mk({ columns: Array.from({ length: 101 }, () => 'last') }));
    invalid(mk({ schemaVersion: 2 }));
    expect(parseSharePayload(mk({ columns: undefined }))).toBeTruthy();
  });

  describe('formulas', () => {
    const frule = { formula: 'last / sma200 - 1', op: '>', value: 0.1 };

    it('round-trips formula rules and formula columns', async () => {
      const spec: ScreenSpec = {
        ...SPEC,
        filter: {
          op: 'and',
          rules: [
            frule as never,
            { formula: 'abs(chg1d)', op: 'between', value: [1, 5] },
            { field: 'rsi14', op: '<', value: 30 },
          ],
        },
        columns: ['last', '=last / sma200 - 1'],
      };
      const p: SharePayload = { v: 1, type: 'screen', name: 'f', spec };
      const link = await buildShareLink(p, '');
      expect(await decodePayload(payloadFromLink(link.link)!)).toEqual(p);
    });

    it('rejects bad formula rules', () => {
      invalid(rule({ ...frule, op: '=' }));
      invalid(rule({ ...frule, op: 'in' }));
      invalid(rule({ ...frule, formula: 3 }));
      invalid(rule({ ...frule, formula: 'last / ' }));
      invalid(rule({ ...frule, formula: 'x'.repeat(201) }));
      invalid(rule({ ...frule, value: 'a' }));
      invalid(rule({ ...frule, value: Infinity }));
      invalid(rule({ ...frule, op: 'between', value: 3 }));
      invalid(rule({ ...frule, op: 'between', value: [1] }));
      invalid(rule({ ...frule, op: 'between', value: [1, 'a'] }));
    });

    it('caps formula rules, counting them against the rule budget', () => {
      const many = (n: number) => ({
        op: 'and',
        rules: Array.from({ length: n }, () => frule),
      });
      expect(parseSharePayload(mk({ filter: many(10) }))).toBeTruthy();
      invalid(mk({ filter: many(11) }));
      const leaf = { field: 'rsi14', op: '<', value: 1 };
      expect(
        parseSharePayload(
          mk({
            filter: {
              op: 'and',
              rules: [...Array.from({ length: 40 }, () => leaf), ...many(10).rules],
            },
          }),
        ),
      ).toBeTruthy();
      invalid(
        mk({
          filter: {
            op: 'and',
            rules: [...Array.from({ length: 41 }, () => leaf), ...many(10).rules],
          },
        }),
      );
    });

    it('validates formula columns', () => {
      const ok = parseSharePayload(mk({ columns: ['=last', '=abs(chg1d)', '=last-sma200'] }));
      expect((ok as { spec: ScreenSpec }).spec.columns).toHaveLength(3);
      invalid(mk({ columns: ['=last', '=last', '=last', '=last'] }));
      invalid(mk({ columns: ['=last +'] }));
      invalid(mk({ columns: ['=' + 'x'.repeat(201)] }));
      invalid(mk({ columns: ['='] }));
    });
  });

  it('caps the number of groups', () => {
    const leaf = { field: 'rsi14', op: '<', value: 1 };
    const groups = (n: number) => ({
      op: 'and',
      rules: Array.from({ length: n }, () => ({ op: 'or', rules: [leaf] })),
    });
    expect(parseSharePayload(mk({ filter: groups(19) }))).toBeTruthy();
    invalid(mk({ filter: groups(20) }));
  });
});

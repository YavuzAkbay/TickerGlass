import { describe, expect, it } from 'vitest';
import { IndicatorRegistry } from './registry';
import { coerceInputs } from './resolve';
import { IndicatorRuntime } from './runtime';
import { randomBars } from './test-utils';
import {
  USER_SCRIPT_PREFIX,
  annotateError,
  compileUserScript,
  definitionFromManifest,
  isSafeColor,
  isUserScriptType,
  parseManifest,
  probeLineOffset,
  scriptIdOf,
  toManifest,
  validateUserDefinition,
} from './user-script';

const LINE_OFFSET = probeLineOffset();

/** A valid user definition (as a script would pass it, id already forced). */
function userDef(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user:abc',
    name: 'My MA',
    shortName: 'MyMA',
    category: 'movingAverage',
    overlay: true,
    inputs: {
      length: { kind: 'int', label: 'Length', default: 10, min: 1 },
      source: { kind: 'source', label: 'Source', default: 'close' },
      mode: { kind: 'enum', label: 'Mode', default: 'a', options: ['a', 'b'] },
      tint: { kind: 'color', label: 'Tint', default: '#ff0000' },
    },
    outputs: [
      {
        type: 'plot',
        id: 'ma',
        title: 'MA',
        kind: 'line',
        color: ['#4f6bed', 'rgba(1, 2, 3, 0.5)'],
      },
      { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: 'gray' },
      {
        type: 'fill',
        id: 'f',
        title: 'Fill',
        between: ['ma', 'zero'],
        color: 'hsla(120deg 50% 50% / 0.2)',
      },
    ],
    setup: () => () => {},
    ...over,
  };
}

function withOutput(o: Record<string, unknown>): Record<string, unknown> {
  return userDef({ outputs: [o] });
}

const SMA_SCRIPT = `
defineIndicator({
  id: 'ignored',
  name: 'Script SMA',
  shortName: 'SSMA',
  category: 'movingAverage',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 5, min: 1 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'ma', title: 'MA', kind: 'line', color: '#4f6bed' }],
  setup({ inputs, ta }) {
    const sma = ta.sma(inputs.length);
    return (c) => c.set('ma', sma.update(c.src.source[c.i]));
  },
});
`;

describe('user script ids', () => {
  it('recognises the user: prefix', () => {
    expect(USER_SCRIPT_PREFIX).toBe('user:');
    expect(isUserScriptType('user:abc')).toBe(true);
    expect(isUserScriptType('sma')).toBe(false);
    expect(scriptIdOf('user:abc-1')).toBe('abc-1');
    expect(scriptIdOf('sma')).toBeUndefined();
  });
});

describe('validateUserDefinition', () => {
  it('accepts a valid definition', () => {
    expect(() => validateUserDefinition(userDef())).not.toThrow();
  });

  it.each([
    [
      'function offset',
      withOutput({
        type: 'plot',
        id: 'a',
        title: 'A',
        kind: 'line',
        color: '#fff',
        offset: () => 1,
      }),
    ],
    [
      'function hline value',
      withOutput({ type: 'hline', id: 'a', title: 'A', value: () => 1, color: '#fff' }),
    ],
    ['function warmup', userDef({ warmup: { bars: () => 10 } })],
    [
      'timeframe input',
      userDef({ inputs: { tf: { kind: 'timeframe', label: 'TF', default: '' } } }),
    ],
    ['symbol input', userDef({ inputs: { s: { kind: 'symbol', label: 'S', default: 'X' } } })],
    [
      'output source default',
      userDef({
        inputs: { s: { kind: 'source', label: 'S', default: { instanceId: 'a', outputId: 'b' } } },
      }),
    ],
    [
      'too many outputs',
      userDef({
        outputs: Array.from({ length: 65 }, (_, k) => ({
          type: 'plot',
          id: `p${k}`,
          title: 'P',
          kind: 'line',
          color: '#fff',
        })),
      }),
    ],
    [
      'too many inputs',
      userDef({
        inputs: Object.fromEntries(
          Array.from({ length: 65 }, (_, k) => [
            `i${k}`,
            { kind: 'bool', label: 'B', default: true },
          ]),
        ),
      }),
    ],
    ['long string', userDef({ name: 'x'.repeat(201) })],
    [
      'url() colour',
      withOutput({ type: 'plot', id: 'a', title: 'A', kind: 'line', color: 'url(https://evil/x)' }),
    ],
    ['url() in rgb()', withOutput({ type: 'bgcolor', id: 'a', title: 'A', color: 'rgb(url(x))' })],
    [
      'expression colour',
      withOutput({ type: 'hline', id: 'a', title: 'A', value: 1, color: 'expression(alert(1))' }),
    ],
    [
      'bad colour input default',
      userDef({ inputs: { c: { kind: 'color', label: 'C', default: 'var(--x)' } } }),
    ],
    ['unknown key', userDef({ script: 'x' })],
    [
      'unknown output key',
      withOutput({ type: 'plot', id: 'a', title: 'A', kind: 'line', color: '#fff', onclick: 'x' }),
    ],
    ['wrong type', userDef({ overlay: 'yes' })],
    ['missing setup', userDef({ setup: undefined })],
    ['non-user id', userDef({ id: 'sma' })],
    ['bad script id', userDef({ id: 'user:a/b' })],
    [
      'enum default not an option',
      userDef({ inputs: { m: { kind: 'enum', label: 'M', default: 'z', options: ['a'] } } }),
    ],
    [
      'fill referencing a missing output',
      withOutput({ type: 'fill', id: 'f', title: 'F', between: ['a', 'b'], color: '#fff' }),
    ],
    [
      '__proto__ input key',
      userDef({
        inputs: JSON.parse('{"__proto__": {"kind": "bool", "label": "B", "default": true}}'),
      }),
    ],
    [
      'toString output id',
      withOutput({ type: 'plot', id: 'toString', title: 'A', kind: 'line', color: '#fff' }),
    ],
  ])('rejects %s', (_name, def) => {
    expect(() => validateUserDefinition(def)).toThrow(
      /Invalid indicator definition|must reference/,
    );
  });

  it('explains static-only fields', () => {
    const def = withOutput({
      type: 'plot',
      id: 'a',
      title: 'A',
      kind: 'line',
      color: '#fff',
      offset: () => 1,
    });
    expect(() => validateUserDefinition(def)).toThrow(/functions are not supported/);
  });

  it('rejects getters', () => {
    const def = userDef();
    Object.defineProperty(def, 'name', { get: () => 'x', enumerable: true });
    expect(() => validateUserDefinition(def)).toThrow(/getter/);
  });

  it('allows repaints and warmup', () => {
    expect(() =>
      validateUserDefinition(userDef({ repaints: true, warmup: { bars: 20 } })),
    ).not.toThrow();
    expect(() => validateUserDefinition(userDef({ warmup: { kind: 'cumulative' } }))).not.toThrow();
    expect(() => validateUserDefinition(userDef({ repaints: false }))).toThrow();
  });
});

describe('colours', () => {
  it.each([
    '#fff',
    '#ffff',
    '#4f6bed',
    '#4f6bed80',
    'rgb(1, 2, 3)',
    'rgba(1,2,3,0.5)',
    'hsl(120 50% 50%)',
    'hsla(120deg, 50%, 50%, 0.3)',
    'RebeccaPurple',
    'transparent',
  ])('accepts %s', (c) => expect(isSafeColor(c)).toBe(true));
  it.each([
    'url(x)',
    'rgb(url(x))',
    '#ggg',
    '#12345',
    'red; background: url(x)',
    'var(--a)',
    'currentColor',
    'image(x)',
    '',
    'rgb(1,2,3) url(x)',
  ])('rejects %s', (c) => expect(isSafeColor(c)).toBe(false));
});

describe('manifests', () => {
  it('round-trips through JSON', () => {
    const m = toManifest(userDef() as never);
    expect(m).not.toHaveProperty('setup');
    const back = parseManifest(JSON.parse(JSON.stringify(m)));
    expect(back).toEqual(m);
    expect(back).not.toBe(m);
  });

  it('copies into fresh objects', () => {
    const raw = JSON.parse(JSON.stringify(toManifest(userDef() as never)));
    const m = parseManifest(raw);
    expect(m.inputs).not.toBe(raw.inputs);
    expect(m.outputs[0]).not.toBe(raw.outputs[0]);
    raw.outputs[0].title = 'changed';
    expect(m.outputs[0]!.title).toBe('MA');
  });

  it('rejects __proto__, unknown keys and setup', () => {
    const m = JSON.parse(JSON.stringify(toManifest(userDef() as never)));
    expect(() => parseManifest({ ...m, setup: 'x' })).toThrow(/unknown key "setup"/);
    expect(() => parseManifest({ ...m, extra: 1 })).toThrow(/unknown key/);
    expect(() =>
      parseManifest(JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(m).slice(1)}`)),
    ).toThrow(/unknown key "__proto__"/);
    const out = JSON.parse(JSON.stringify(m));
    out.outputs[0] = JSON.parse(`{"__proto__": {}, ${JSON.stringify(out.outputs[0]).slice(1)}`);
    expect(() => parseManifest(out)).toThrow(/__proto__/);
    expect(() => parseManifest({ ...m, inputs: { constructor: m.inputs.length } })).toThrow(
      /invalid key/,
    );
    expect(() => parseManifest(null)).toThrow();
    expect(() => parseManifest([])).toThrow();
  });

  it('builds a stub definition that never runs code', () => {
    const def = definitionFromManifest(toManifest(userDef() as never));
    expect(def.id).toBe('user:abc');
    expect(() => def.setup({} as never)).toThrow(/sandbox/);
    const reg = new IndicatorRegistry();
    reg.register(def);
    expect(reg.get('user:abc')).toBe(def);
    expect(reg.unregister('user:abc')).toBe(true);
    expect(reg.get('user:abc')).toBeUndefined();
    expect(reg.unregister('user:abc')).toBe(false);
    reg.register(def);
  });
});

describe('coerceInputs', () => {
  const def = definitionFromManifest(toManifest(userDef() as never));

  it('keeps valid values and defaults invalid ones without throwing', () => {
    expect(
      coerceInputs(def, {
        length: 7.6,
        source: { instanceId: 'x', outputId: 'y' },
        mode: 'zzz',
        tint: 'url(x)',
        gone: 1,
      }),
    ).toEqual({ length: 8, source: 'close', mode: 'a', tint: '#ff0000' });
    expect(
      coerceInputs(def, { length: 'x' as never, source: 'hl2', mode: 'b', tint: 'blue' }),
    ).toEqual({
      length: 10,
      source: 'hl2',
      mode: 'b',
      tint: 'blue',
    });
    expect(coerceInputs(def, { length: 0 })).toMatchObject({ length: 1 });
    expect(coerceInputs(def)).toEqual({ length: 10, source: 'close', mode: 'a', tint: '#ff0000' });
  });

  it('keeps output refs for built-ins', () => {
    const builtin = { ...def, id: 'b' };
    expect(coerceInputs(builtin, { source: { instanceId: 'x', outputId: 'y' } }).source).toEqual({
      instanceId: 'x',
      outputId: 'y',
    });
  });
});

describe('compileUserScript', () => {
  it('probes a line offset', () => {
    expect(LINE_OFFSET).toBeTypeOf('number');
  });

  it('compiles and runs like a built-in, with a forced id', () => {
    const { definition, manifest } = compileUserScript(SMA_SCRIPT, {
      scriptId: 's1',
      lineOffset: LINE_OFFSET,
    });
    expect(definition.id).toBe('user:s1');
    expect(manifest.id).toBe('user:s1');
    expect(manifest).not.toHaveProperty('setup');
    const reg = new IndicatorRegistry();
    reg.register(definition);
    const rt = new IndicatorRuntime({ registry: reg });
    rt.add({ id: 'a', type: 'user:s1', inputs: { length: 3 } });
    const bars = randomBars(10);
    rt.setBars(bars);
    const r = rt.result('a')!;
    expect(r.status).toEqual({ state: 'ok' });
    const c = bars.close;
    expect(r.values.ma![2]).toBeCloseTo((c[0]! + c[1]! + c[2]!) / 3, 9);
    expect(r.values.ma![1]).toBeNaN();
  });

  it('requires exactly one defineIndicator call', () => {
    expect(() =>
      compileUserScript('const x = 1;', { scriptId: 's', lineOffset: LINE_OFFSET }),
    ).toThrow(/must call defineIndicator/);
    const twice = SMA_SCRIPT + SMA_SCRIPT;
    expect(() => compileUserScript(twice, { scriptId: 's', lineOffset: LINE_OFFSET })).toThrow(
      /only be called once/,
    );
    const swallowed = `try { ${SMA_SCRIPT} ${SMA_SCRIPT} } catch {}`;
    expect(() => compileUserScript(swallowed, { scriptId: 's', lineOffset: LINE_OFFSET })).toThrow(
      /only be called once/,
    );
  });

  it('rejects calls after loading', () => {
    const src = `${SMA_SCRIPT}\nglobalThis.__late = defineIndicator;`;
    compileUserScript(src, { scriptId: 's', lineOffset: LINE_OFFSET });
    const g = globalThis as { __late?: (d: unknown) => unknown };
    const late = g.__late!;
    delete g.__late;
    expect(() => late({})).toThrow(/while the script loads/);
  });

  it('runs in strict mode with frozen injected names', () => {
    expect(() =>
      compileUserScript('undeclared = 1;', { scriptId: 's', lineOffset: LINE_OFFSET }),
    ).toThrow(/ReferenceError/);
    expect(() =>
      compileUserScript('PRICE_SOURCES.push("x");', { scriptId: 's', lineOffset: LINE_OFFSET }),
    ).toThrow(/TypeError/);
    expect(() =>
      compileUserScript('defineIndicator.x = 1;', { scriptId: 's', lineOffset: LINE_OFFSET }),
    ).toThrow(/TypeError/);
    const ok = `if (NO_COLOR !== 255 || typeof calendarPeriod !== 'function' || PRICE_SOURCES[3] !== 'close') throw new Error('bad');\n${SMA_SCRIPT}`;
    expect(() => compileUserScript(ok, { scriptId: 's', lineOffset: LINE_OFFSET })).not.toThrow();
  });

  it('validates the definition', () => {
    const bad = SMA_SCRIPT.replace("color: '#4f6bed'", "color: 'url(x)'");
    expect(() => compileUserScript(bad, { scriptId: 's', lineOffset: LINE_OFFSET })).toThrow(
      /colour/,
    );
    expect(() =>
      compileUserScript(SMA_SCRIPT, { scriptId: 'a b', lineOffset: LINE_OFFSET }),
    ).toThrow(/Invalid script id/);
  });

  it('annotates load errors with the script line', () => {
    const src = 'const a = 1;\n\n  null.x;\n';
    expect(() => compileUserScript(src, { scriptId: 's', lineOffset: LINE_OFFSET })).toThrow(
      /^TypeError: .* \(line 3:8\)$/,
    );
  });

  it('reports syntax errors', () => {
    expect(() => compileUserScript('let = ;', { scriptId: 's', lineOffset: LINE_OFFSET })).toThrow(
      /SyntaxError/,
    );
  });

  it('annotates setup and step errors with the script line', () => {
    const src = (setupBody: string, stepBody: string) => `defineIndicator({
  id: 'x', name: 'X', shortName: 'X', category: 'other', overlay: false,
  inputs: {},
  outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
  setup() {
    ${setupBody}
    return (c) => {
      ${stepBody}
    };
  },
});`;
    const run = (setupBody: string, stepBody: string) => {
      const code = src(setupBody, stepBody);
      const reg = new IndicatorRegistry();
      reg.register(compileUserScript(code, { scriptId: 's', lineOffset: LINE_OFFSET }).definition);
      const rt = new IndicatorRuntime({ registry: reg });
      rt.add({ id: 'a', type: 'user:s', inputs: {} });
      rt.setBars(randomBars(5));
      return rt.status('a');
    };
    expect(run('throw new RangeError("boom");', '')).toEqual({
      state: 'error',
      message: 'RangeError: boom (line 6:11)',
    });
    expect(run('', 'if (c.i === 3) undefined.x;')).toEqual({
      state: 'error',
      message: expect.stringMatching(/^TypeError: .* \(line 8:\d+\)$/),
    });
    expect(run('', 'c.set("nope", 1);')).toEqual({
      state: 'error',
      message: expect.stringMatching(/\(line 8:9\)$/),
    });
    expect(run('return 1;', '')).toEqual({
      state: 'error',
      message: 'setup() must return the step function',
    });
  });
});

describe('annotateError', () => {
  it('handles thrown non-errors and missing frames', () => {
    expect(annotateError('plain', 3).message).toBe('plain');
    expect(annotateError(new Error('x'), 3).message).toBe('x');
    expect(annotateError(new TypeError('y'), undefined).message).toBe('TypeError: y');
    const hostile = {
      toString() {
        throw new Error('no');
      },
    };
    expect(annotateError(hostile, 3).message).toMatch(/cannot be displayed/);
    expect(annotateError('x'.repeat(10_000), 3).message.length).toBeLessThan(600);
  });

  it('subtracts the line offset', () => {
    const err = new Error('z');
    err.stack = 'Error: z\n    at eval (user-script.js:12:5)\n    at foo (other.js:1:1)';
    expect(annotateError(err, 3).message).toBe('z (line 9:5)');
    expect(annotateError(err, 20).message).toBe('z');
  });
});

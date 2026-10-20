/**
 * User scripts: indicators written by the user in plain JS with the same
 * `defineIndicator({...})` API as the built-ins (docs/plans/user-scripts.md).
 *
 * Script code only ever runs in a sandbox (a locked-down worker; Node in
 * tests). Everywhere else a script is known by its manifest: a JSON copy of
 * the definition without `setup`, re-validated with `parseManifest` and
 * registered as a stub (`definitionFromManifest`) so dialogs, legends and
 * `resolveOutputs` work unchanged without running user code.
 *
 * Registry ids are `user:<scriptId>` and are persisted in layouts
 * (`IndicatorState.type`): never change the format.
 */
import { calendarPeriod } from './calendar';
import { validateDefinition, type AnyIndicatorDefinition } from './registry';
import {
  NO_COLOR,
  PRICE_SOURCES,
  type InputDef,
  type OutputDef,
  type SymbolInputDef,
  type TimeframeInputDef,
} from './types';

/** Registry id prefix of user scripts: `user:<scriptId>`. */
export const USER_SCRIPT_PREFIX = 'user:';

/** Version of the script contract (injected names, `defineIndicator` shape). */
export const USER_SCRIPT_API_VERSION = 1;

/** Input kinds a user script may declare (no timeframe/symbol inputs in v1). */
export type UserInputDef = Exclude<InputDef, TimeframeInputDef | SymbolInputDef>;

/**
 * JSON copy of a user script's definition without `setup`. Every field is
 * static (no functions of inputs), so the main thread can use it without
 * running user code.
 */
export interface UserScriptManifest extends Omit<
  AnyIndicatorDefinition,
  'setup' | 'inputs' | 'outputs' | 'warmup'
> {
  inputs: Record<string, UserInputDef>;
  outputs: readonly OutputDef[];
  warmup?: { kind: 'cumulative' } | { bars: number };
}

export interface CompileOptions {
  /** Script id; the registry id is forced to `user:<scriptId>`. */
  scriptId: string;
  /**
   * Lines the compile wrapper adds before the script body: `probeLineOffset()`,
   * measured once per engine. Undefined = errors carry no line numbers.
   */
  lineOffset: number | undefined;
}

export interface CompiledUserScript {
  /** Runnable definition: manifest fields plus a `setup` that annotates errors. */
  definition: AnyIndicatorDefinition;
  manifest: UserScriptManifest;
}

const SCRIPT_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;
const MAX_INPUTS = 64;
const MAX_OUTPUTS = 64;
/** Keywords, enum options and palettes. */
const MAX_LIST = 64;
const MAX_STRING = 200;
const MAX_ERROR_MESSAGE = 500;

export function isUserScriptType(type: string): boolean {
  return type.startsWith(USER_SCRIPT_PREFIX);
}

/** Script id of a `user:<scriptId>` type, undefined for other types. */
export function scriptIdOf(type: string): string | undefined {
  return isUserScriptType(type) ? type.slice(USER_SCRIPT_PREFIX.length) : undefined;
}

// ------------------------------------------------------------- validation

class DefinitionError extends Error {
  constructor(path: string, problem: string) {
    super(`Invalid indicator definition: ${path} ${problem}`);
    this.name = 'DefinitionError';
  }
}

function fail(path: string, problem: string): never {
  throw new DefinitionError(path, problem);
}

function wrongType(path: string, expected: string, v: unknown): never {
  return fail(
    path,
    typeof v === 'function'
      ? `must be a static ${expected} (functions are not supported in user scripts)`
      : `must be ${expected}`,
  );
}

/** Keys that would shadow or reach Object.prototype on a plain object. */
function isSafeKey(k: string): boolean {
  return k !== '' && k !== 'prototype' && !(k in Object.prototype);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own data property (accessors rejected, so values are read exactly once). */
function field(obj: object, key: string, path: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return undefined;
  if (!('value' in d)) fail(`${path}.${key}`, 'must be a plain value, not a getter');
  return d.value;
}

/** Plain object whose own keys are all in `allowed`. */
function record(v: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(v)) return wrongType(path, 'an object', v);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== 'string' || !allowed.includes(k)) fail(path, `has unknown key "${String(k)}"`);
  }
  return v;
}

/** Plain object used as a dictionary: own string keys, none reaching Object.prototype. */
function dictionary(v: unknown, path: string, max: number): [string, unknown][] {
  if (!isPlainObject(v)) return wrongType(path, 'an object', v);
  const keys = Reflect.ownKeys(v);
  if (keys.length > max) fail(path, `has more than ${max} entries`);
  return keys.map((k) => {
    if (typeof k !== 'string' || !isSafeKey(k) || k.length > MAX_STRING)
      fail(path, `has invalid key "${String(k)}"`);
    return [k, field(v, k, path)];
  });
}

function list(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) return wrongType(path, 'an array', v);
  if (v.length > max) fail(path, `has more than ${max} entries`);
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i++) out.push(field(v, String(i), path));
  return out;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') return wrongType(path, 'a string', v);
  if (v.length > MAX_STRING) fail(path, `is longer than ${MAX_STRING} characters`);
  return v;
}

function id(v: unknown, path: string): string {
  const s = str(v, path);
  if (!isSafeKey(s)) fail(path, `"${s}" is not a valid id`);
  return s;
}

function bool(v: unknown, path: string): boolean {
  return typeof v === 'boolean' ? v : wrongType(path, 'a boolean', v);
}

function num(v: unknown, path: string): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : wrongType(path, 'a finite number', v);
}

function int(v: unknown, path: string): number {
  return Number.isInteger(v) ? (v as number) : wrongType(path, 'an integer', v);
}

function oneOf<T extends string>(options: readonly T[]) {
  return (v: unknown, path: string): T =>
    typeof v === 'string' && (options as readonly string[]).includes(v)
      ? (v as T)
      : wrongType(path, `one of ${options.join(', ')}`, v);
}

// CSS Color 4 named colours (lowercase) plus 'transparent'.
const NAMED_COLORS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen transparent'
  ).split(' '),
);
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// Numbers, %, separators and at most one angle unit; no nested parentheses.
const FUNC_COLOR_RE = /^(?:rgba?|hsla?)\([\d\s.,%/+-]*(?:deg|rad|grad|turn)?[\d\s.,%/+-]*\)$/i;

/** Hex, rgb(), rgba(), hsl(), hsla() or a CSS named colour. Nothing else (no url(...)). */
export function isSafeColor(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_STRING) return false;
  const s = v.trim();
  return HEX_COLOR_RE.test(s) || FUNC_COLOR_RE.test(s) || NAMED_COLORS.has(s.toLowerCase());
}

function color(v: unknown, path: string): string {
  return isSafeColor(v) ? v : wrongType(path, 'a colour (hex, rgb(a), hsl(a) or CSS name)', v);
}

function colorSpec(v: unknown, path: string): string | string[] {
  if (!Array.isArray(v)) return color(v, path);
  const p = list(v, path, MAX_LIST);
  if (p.length === 0) fail(path, 'must not be an empty palette');
  return p.map((c, k) => color(c, `${path}[${k}]`));
}

type Reader = (v: unknown, path: string) => unknown;

/**
 * Copies `keys` of `src` through their readers into a fresh object. Keys
 * listed in `required` must be present; absent (undefined) optional keys are
 * left out.
 */
function copy(
  src: Record<string, unknown>,
  path: string,
  readers: Record<string, Reader>,
  required: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, read] of Object.entries(readers)) {
    const v = field(src, k, path);
    if (v === undefined) {
      if (required.includes(k)) fail(`${path}.${k}`, 'is required');
      continue;
    }
    out[k] = read(v, `${path}.${k}`);
  }
  return out;
}

const PLOT_KINDS = ['line', 'step', 'histogram', 'area', 'columns', 'circles', 'cross'] as const;
const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const SHAPES = [
  'triangleUp',
  'triangleDown',
  'arrowUp',
  'arrowDown',
  'circle',
  'cross',
  'xcross',
  'diamond',
  'square',
  'flag',
  'labelUp',
  'labelDown',
] as const;
const SHAPE_LOCATIONS = ['aboveBar', 'belowBar', 'absolute', 'top', 'bottom'] as const;
const SHAPE_SIZES = ['tiny', 'small', 'normal', 'large', 'huge'] as const;
const CATEGORIES = [
  'movingAverage',
  'trend',
  'momentum',
  'volatility',
  'volume',
  'bands',
  'other',
] as const;
const FORMATS = ['inherit', 'price', 'volume', 'percent'] as const;
const USER_INPUT_KINDS = ['int', 'float', 'bool', 'source', 'color', 'enum', 'time'] as const;

const INPUT_BASE: Record<string, Reader> = {
  kind: oneOf(USER_INPUT_KINDS),
  label: str,
  group: str,
  inline: str,
  tooltip: str,
  hideInTitle: bool,
};

function readInput(raw: unknown, path: string): UserInputDef {
  const kindValue = isPlainObject(raw) ? field(raw, 'kind', path) : undefined;
  const kind = oneOf(USER_INPUT_KINDS)(kindValue, `${path}.kind`);
  const readers: Record<string, Reader> = { ...INPUT_BASE };
  switch (kind) {
    case 'int':
    case 'float':
      Object.assign(readers, { default: num, min: num, max: num, step: num });
      break;
    case 'time':
      readers.default = num;
      break;
    case 'bool':
      readers.default = bool;
      break;
    case 'source':
      readers.default = oneOf(PRICE_SOURCES);
      break;
    case 'color':
      readers.default = color;
      break;
    case 'enum':
      Object.assign(readers, {
        default: str,
        options: (v: unknown, p: string) => {
          const opts = list(v, p, MAX_LIST).map((o, k) => str(o, `${p}[${k}]`));
          if (opts.length === 0) fail(p, 'must not be empty');
          if (new Set(opts).size !== opts.length) fail(p, 'has duplicate options');
          return opts;
        },
        optionLabels: (v: unknown, p: string) =>
          Object.fromEntries(dictionary(v, p, MAX_LIST).map(([k, l]) => [k, str(l, `${p}.${k}`)])),
      });
      break;
  }
  const r = record(raw, path, Object.keys(readers));
  const out = copy(r, path, readers, ['kind', 'label', 'default']);
  if (kind === 'enum') {
    const opts = out.options as string[] | undefined;
    if (!opts) fail(`${path}.options`, 'is required');
    for (const k of Object.keys((out.optionLabels as object | undefined) ?? {}))
      if (!opts.includes(k)) fail(`${path}.optionLabels`, `has unknown option "${k}"`);
  }
  return out as unknown as UserInputDef;
}

const OUTPUT_BASE: Record<string, Reader> = { type: str, id, title: str, visible: bool };
const OUTPUT_READERS: Record<OutputDef['type'], Record<string, Reader>> = {
  plot: {
    kind: oneOf(PLOT_KINDS),
    color: colorSpec,
    lineWidth: num,
    lineStyle: oneOf(LINE_STYLES),
    base: (v, p) => (v === null ? null : num(v, p)),
    offset: int,
    showLastValue: bool,
    connectGaps: bool,
  },
  hline: { value: num, color, lineWidth: num, lineStyle: oneOf(LINE_STYLES) },
  fill: {
    between: (v, p) => {
      const b = list(v, p, 2).map((x, k) => id(x, `${p}[${k}]`));
      if (b.length !== 2) fail(p, 'must name exactly two outputs');
      return b;
    },
    color: colorSpec,
  },
  bgcolor: { color: colorSpec, offset: int },
  shape: {
    shape: oneOf(SHAPES),
    location: oneOf(SHAPE_LOCATIONS),
    size: oneOf(SHAPE_SIZES),
    color: colorSpec,
    text: str,
    textFromValue: bool,
    textColor: color,
    offset: int,
  },
  volumeProfile: {
    mode: oneOf(['visible', 'session'] as const),
    rowsLayout: oneOf(['count', 'size'] as const),
    rows: num,
    rowSize: num,
    valueArea: num,
    widthPercent: num,
    placement: oneOf(['left', 'right'] as const),
    upColor: color,
    downColor: color,
    valueAreaUpColor: color,
    valueAreaDownColor: color,
    pocColor: color,
  },
};
const OUTPUT_REQUIRED: Record<OutputDef['type'], readonly string[]> = {
  plot: ['kind', 'color'],
  hline: ['value', 'color'],
  fill: ['between', 'color'],
  bgcolor: ['color'],
  shape: ['shape', 'location', 'color'],
  volumeProfile: Object.keys(OUTPUT_READERS.volumeProfile),
};
const OUTPUT_TYPES = Object.keys(OUTPUT_READERS) as OutputDef['type'][];

function readOutput(raw: unknown, path: string): OutputDef {
  const typeValue = isPlainObject(raw) ? field(raw, 'type', path) : undefined;
  const type = oneOf(OUTPUT_TYPES)(typeValue, `${path}.type`);
  const readers = { ...OUTPUT_BASE, ...OUTPUT_READERS[type] };
  const r = record(raw, path, Object.keys(readers));
  return copy(r, path, readers, [
    'type',
    'id',
    'title',
    ...OUTPUT_REQUIRED[type],
  ]) as unknown as OutputDef;
}

const TOP_READERS: Record<string, Reader> = {
  id: str,
  name: str,
  shortName: str,
  category: oneOf(CATEGORIES),
  keywords: (v, p) => list(v, p, MAX_LIST).map((k, i) => str(k, `${p}[${i}]`)),
  overlay: bool,
  format: oneOf(FORMATS),
  precision: (v, p) => {
    const n = int(v, p);
    if (n < 0 || n > 16) fail(p, 'must be between 0 and 16');
    return n;
  },
  scaleRange: (v, p) => {
    const r = copy(record(v, p, ['min', 'max']), p, { min: num, max: num }, ['min', 'max']);
    if (!((r.min as number) < (r.max as number))) fail(p, 'min must be below max');
    return r;
  },
  inputs: (v, p) => {
    const entries = dictionary(v, p, MAX_INPUTS);
    return Object.fromEntries(entries.map(([k, d]) => [k, readInput(d, `${p}.${k}`)]));
  },
  outputs: (v, p) => list(v, p, MAX_OUTPUTS).map((o, k) => readOutput(o, `${p}[${k}]`)),
  repaints: (v, p) => (v === true ? true : wrongType(p, 'true', v)),
  warmup: (v, p) => {
    if (isPlainObject(v) && field(v, 'kind', p) !== undefined)
      return copy(record(v, p, ['kind']), p, { kind: oneOf(['cumulative'] as const) }, ['kind']);
    const r = copy(record(v, p, ['bars']), p, { bars: int }, ['bars']);
    if ((r.bars as number) < 0) fail(`${p}.bars`, 'must not be negative');
    return r;
  },
};
const TOP_REQUIRED = ['id', 'name', 'shortName', 'category', 'overlay', 'inputs', 'outputs'];

function stubSetup(): never {
  throw new Error('user scripts run in their sandbox');
}

/**
 * Strict whitelist copy of a definition (`withSetup`: `setup` must be a
 * function and is returned separately) or of a manifest. `forcedId` replaces
 * whatever id the source has.
 */
function readDefinition(
  raw: unknown,
  withSetup: boolean,
  forcedId?: string,
): { manifest: UserScriptManifest; setup: unknown } {
  const keys = Object.keys(TOP_READERS);
  const r = record(raw, 'definition', withSetup ? [...keys, 'setup'] : keys);
  let m: Record<string, unknown>;
  if (forcedId === undefined) {
    m = copy(r, 'definition', TOP_READERS, TOP_REQUIRED);
  } else {
    // The script's own id (if any) is ignored.
    const { id: _ignored, ...readers } = TOP_READERS;
    m = {
      id: forcedId,
      ...copy(
        r,
        'definition',
        readers,
        TOP_REQUIRED.filter((k) => k !== 'id'),
      ),
    };
  }
  const typeId = m.id as string;
  const scriptId = scriptIdOf(typeId);
  if (scriptId === undefined || !SCRIPT_ID_RE.test(scriptId))
    fail('definition.id', `"${typeId}" is not a user script id (user:[A-Za-z0-9_-]{1,36})`);
  const manifest = m as unknown as UserScriptManifest;
  for (const [k, d] of Object.entries(manifest.inputs)) {
    if (d.kind === 'enum' && !d.options.includes(d.default))
      fail(`definition.inputs.${k}.default`, 'is not one of the options');
  }
  validateDefinition({ ...manifest, setup: stubSetup });
  if (!withSetup) return { manifest, setup: undefined };
  const setup = field(r, 'setup', 'definition');
  if (typeof setup !== 'function') fail('definition.setup', 'must be a function');
  return { manifest, setup };
}

/**
 * v1 restrictions on a user script definition (on top of `validateDefinition`):
 * id `user:<scriptId>`, input kinds int/float/bool/source/color/enum/time,
 * price-source defaults, static outputs and warmup (no functions of inputs),
 * at most 64 inputs/outputs, strings of at most 200 characters, colours
 * limited to hex/rgb(a)/hsl(a)/CSS names, no unknown keys. Throws on the first
 * problem.
 */
export function validateUserDefinition(def: unknown): asserts def is AnyIndicatorDefinition {
  readDefinition(def, true);
}

/** Fresh JSON-safe copy of a valid user definition without `setup`. Throws if invalid. */
export function toManifest(def: AnyIndicatorDefinition): UserScriptManifest {
  return readDefinition(def, true).manifest;
}

/**
 * Re-validates a manifest from an untrusted place (sandbox message, API, local
 * cache): strict whitelist (unknown keys, `__proto__` and friends rejected),
 * same rules as `validateUserDefinition`. Returns a fresh object.
 */
export function parseManifest(raw: unknown): UserScriptManifest {
  return readDefinition(raw, false).manifest;
}

/**
 * Registry stub for the main thread: the manifest's metadata with a `setup`
 * that throws (user code only runs in the sandbox).
 */
export function definitionFromManifest(manifest: UserScriptManifest): AnyIndicatorDefinition {
  return { ...parseManifest(manifest), setup: stubSetup };
}

// ---------------------------------------------------------------- compile

const SCRIPT_PARAMS = ['defineIndicator', 'NO_COLOR', 'PRICE_SOURCES', 'calendarPeriod'] as const;
const SCRIPT_URL = 'user-script.js';
const USER_FRAME_RE = /user-script\.js:(\d+):(\d+)/;

type ScriptFn = (
  defineIndicator: (def: unknown) => unknown,
  noColor: number,
  priceSources: readonly string[],
  calendar: typeof calendarPeriod,
) => unknown;

/** The one wrapper every script (and the line-offset probe) is compiled with. */
function wrapScript(source: string): ScriptFn {
  return new Function(
    ...SCRIPT_PARAMS,
    `"use strict";\n${source}\n//# sourceURL=${SCRIPT_URL}`,
  ) as ScriptFn;
}

/**
 * Lines the compile wrapper puts before script line 1 in engine stack traces,
 * measured by compiling `throw new Error()` the same way. Undefined if the
 * engine's stacks do not name the script (no line numbers then).
 */
export function probeLineOffset(): number | undefined {
  try {
    (wrapScript('throw new Error();') as () => unknown)();
  } catch (err) {
    const m = USER_FRAME_RE.exec(String((err as { stack?: unknown }).stack ?? ''));
    if (m) return Number(m[1]) - 1;
  }
  return undefined;
}

/**
 * New Error whose message is "Name: message (line L:C)", the location being
 * the innermost script frame of the stack with `lineOffset` subtracted. No
 * location when it cannot be found. Never throws, whatever was thrown.
 */
export function annotateError(err: unknown, lineOffset: number | undefined): Error {
  let name = '';
  let message: string;
  let stack = '';
  try {
    if (err instanceof Error) {
      name = String(err.name);
      message = String(err.message);
      stack = String(err.stack ?? '');
    } else {
      message = String(err);
    }
  } catch {
    message = 'Script threw a value that cannot be displayed';
  }
  let where = '';
  const m = USER_FRAME_RE.exec(stack);
  if (m && lineOffset !== undefined) {
    const line = Number(m[1]) - lineOffset;
    if (line >= 1) where = ` (line ${line}:${m[2]})`;
  }
  const prefix = name && name !== 'Error' ? `${name}: ` : '';
  const text = prefix + message;
  return new Error(
    (text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text) + where,
  );
}

const FROZEN_PRICE_SOURCES = Object.freeze([...PRICE_SOURCES]);
const FROZEN_CALENDAR_PERIOD: typeof calendarPeriod = Object.freeze(
  (
    time: number,
    unit: Parameters<typeof calendarPeriod>[1],
    tz?: string,
    session?: string | null,
  ) => calendarPeriod(time, unit, tz, session),
);

/**
 * Runs a script body (strict mode, injected frozen `defineIndicator`,
 * `NO_COLOR`, `PRICE_SOURCES`, `calendarPeriod`) and returns its validated
 * definition with id `user:<scriptId>`. The script must call
 * `defineIndicator` exactly once, synchronously; the id it gives is ignored.
 * Errors thrown by the body, `setup` or `step` are rethrown through
 * `annotateError` (line numbers). Executes user code: call only inside the
 * sandbox (or tests).
 */
export function compileUserScript(source: string, opts: CompileOptions): CompiledUserScript {
  if (!SCRIPT_ID_RE.test(opts.scriptId))
    throw new Error(`Invalid script id "${opts.scriptId}" (expected [A-Za-z0-9_-]{1,36})`);
  const { lineOffset } = opts;
  let fn: ScriptFn;
  try {
    fn = wrapScript(source);
  } catch (err) {
    throw annotateError(err, lineOffset);
  }

  let calls = 0;
  let open = true;
  let raw: unknown;
  const define = Object.freeze(function defineIndicator(def: unknown): unknown {
    if (!open) throw new Error('defineIndicator() must be called while the script loads');
    calls++;
    if (calls > 1) throw new Error('defineIndicator() may only be called once');
    raw = def;
    return def;
  });
  try {
    fn(define, NO_COLOR, FROZEN_PRICE_SOURCES, FROZEN_CALENDAR_PERIOD);
  } catch (err) {
    throw annotateError(err, lineOffset);
  } finally {
    open = false;
  }
  if (calls !== 1)
    throw new Error(
      calls === 0
        ? 'The script must call defineIndicator({...})'
        : 'defineIndicator() may only be called once',
    );

  const { manifest, setup } = readDefinition(raw, true, USER_SCRIPT_PREFIX + opts.scriptId);
  if (typeof setup !== 'function') throw new Error('setup() must be a function');
  const userSetup = setup as (ctx: unknown) => unknown;
  const definition: AnyIndicatorDefinition = {
    ...manifest,
    setup(ctx) {
      let step: unknown;
      try {
        step = userSetup(ctx);
      } catch (err) {
        throw annotateError(err, lineOffset);
      }
      if (typeof step !== 'function') throw new Error('setup() must return the step function');
      const userStep = step as (c: unknown) => unknown;
      return (c) => {
        try {
          userStep(c);
        } catch (err) {
          throw annotateError(err, lineOffset);
        }
      };
    },
  };
  return { definition, manifest };
}

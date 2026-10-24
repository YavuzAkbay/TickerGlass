/**
 * `AlertIn` validation (docs/alerts.md §1.2). Must agree with the API's
 * pydantic models (`api/.../userdata/alerts.py`): both run
 * `test/fixtures/{valid,invalid}/*.json`. Unknown keys are rejected, and the
 * optional body fields get the API's defaults. On top of the shape checks, TS
 * checks indicator types, plot outputs, input values and cycles against a
 * registry (Python checks only the shape; those cases live in `invalid-ts/`).
 */
import {
  defaultRegistry,
  isExternalRef,
  isOutputRef,
  resolveInputs,
  usesEvents,
  usesFundamentals,
  type IndicatorRegistry,
  type InputValueMap,
} from '@tickerglass/indicators';
import { isChannelTool, supportsPart, TOOL_POINTS } from './drawing-levels';
import { upgradeAlertSpec } from './legacy';
import {
  CHANNEL_OPS,
  CROSS_OPS,
  DEFAULT_NOTIFY,
  MOVING_OPS,
  PRICE_FIELDS,
  TRIGGER_MODES,
  type AlertIn,
  type AlertNotify,
} from './types';

export type ValidationCode =
  | 'required'
  | 'type'
  | 'format'
  | 'range'
  | 'length'
  | 'enum'
  | 'extra'
  | 'reserved'
  | 'unique'
  | 'reference'
  | 'too_large'
  | 'unknown_indicator'
  | 'unknown_output'
  | 'unsupported_indicator'
  | 'invalid_inputs'
  | 'cycle'
  | 'drawing_not_saved'
  | 'drawing_unsupported'
  | 'drawing_symbol';

export interface ValidationError {
  /** Dotted path into the AlertIn body, e.g. `spec.condition.amount`, `spec.left.ref.instances.0.id`. */
  path: string;
  code: ValidationCode;
  message: string;
}

/** On success, `alert` is the body with the API's defaults filled in and `name` trimmed. */
export type ValidationResult =
  { ok: true; alert: AlertIn } | { ok: false; errors: ValidationError[] };

/** The fields of a stored drawing the validation reads (as the API does). */
export interface DrawingInfo {
  type: string;
  points: readonly unknown[];
  scope: 'symbol' | 'all';
  symbol: string;
}

export interface ValidateOptions {
  /**
   * Stored drawings by id. When given, drawing operands must exist, support
   * the part, and belong to the alert's symbol (or scope `all`).
   */
  drawing?: (id: string) => DrawingInfo | null | undefined;
}

export const ALERT_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;
export const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const INTERVAL_RE = /^[1-9][0-9]{0,5}[mhDWM]$/;
/** Python `str.isprintable()`: no control/format/unassigned/separator characters except ' '. */
const PRINTABLE_RE = /^(?:[^\p{C}\p{Z}]| )*$/u;
export const WEBHOOK_URL_RE = /^https?:\/\//;
/** ISO 8601 date or date-time; without a zone it is read as UTC by the API. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** Words used by fixed route segments under /alerts (§1.4). */
export const RESERVED_ALERT_IDS: readonly string[] = ['log', 'states', 'channels', 'service'];

export const LIMITS = {
  name: 200,
  symbol: 128,
  message: 2000,
  webhookUrl: 500,
  specBytes: 64 * 1024,
  /** Indicator instances per spec (all refs together). */
  instances: 16,
  /** Drawing ids, indicator types, output ids, input keys. */
  shortId: 64,
  inputs: 64,
  inputString: 200,
  title: 200,
  maxBars: 1000,
  maxPercent: 10_000,
} as const;

const NOTIFY_BOOLS = [
  'toast',
  'sound',
  'browser',
  'webhook',
  'webhookRaw',
  'telegram',
  'email',
] as const;
const PARTS = ['line', 'upper', 'lower', 'middle'];
const SCALES = ['linear', 'log'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Length in code points (Python `len`). */
const cpLength = (s: string) => Array.from(s).length;

class Checker {
  readonly errors: ValidationError[] = [];
  instances = 0;
  constructor(
    readonly registry: IndicatorRegistry,
    readonly opts: ValidateOptions,
    readonly symbol: string | null,
  ) {}

  err(path: string, code: ValidationCode, message: string): void {
    this.errors.push({ path, code, message });
  }

  /** An object with only `allowed` keys. */
  obj(v: unknown, path: string, allowed: readonly string[]): v is Obj {
    if (!isObj(v)) {
      this.err(path, v === undefined ? 'required' : 'type', `${path || 'body'} must be an object`);
      return false;
    }
    for (const k of Object.keys(v))
      if (!allowed.includes(k)) this.err(join(path, k), 'extra', `unknown field '${k}'`);
    return true;
  }

  str(v: unknown, path: string): v is string {
    if (typeof v === 'string') return true;
    this.err(path, v === undefined ? 'required' : 'type', `${path} must be a string`);
    return false;
  }

  /** String of 1..max code points. */
  short(v: unknown, path: string, max: number = LIMITS.shortId): v is string {
    if (!this.str(v, path)) return false;
    const n = cpLength(v);
    if (n >= 1 && n <= max) return true;
    this.err(path, 'length', `${path} must be 1..${max} characters`);
    return false;
  }

  bool(v: unknown, path: string): v is boolean {
    if (typeof v === 'boolean') return true;
    this.err(path, v === undefined ? 'required' : 'type', `${path} must be a boolean`);
    return false;
  }

  num(v: unknown, path: string): v is number {
    if (isFiniteNum(v)) return true;
    this.err(path, v === undefined ? 'required' : 'type', `${path} must be a finite number`);
    return false;
  }

  oneOf(v: unknown, options: readonly string[], path: string): boolean {
    if (!this.str(v, path)) return false;
    if (options.includes(v)) return true;
    this.err(path, 'enum', `${path} must be one of ${options.join(', ')}`);
    return false;
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

const ALERT_KEYS = [
  'id',
  'name',
  'symbol',
  'interval',
  'prepost',
  'spec',
  'message',
  'notify',
  'expiresAt',
  'status',
];

/**
 * Validate an `AlertIn` body (an object or parsed JSON). `registry` defaults
 * to the built-in indicators.
 */
export function validateAlert(
  input: unknown,
  registry: IndicatorRegistry = defaultRegistry,
  opts: ValidateOptions = {},
): ValidationResult {
  const symbol = isObj(input) && typeof input['symbol'] === 'string' ? input['symbol'] : null;
  const c = new Checker(registry, opts, symbol);
  if (!c.obj(input, '', ALERT_KEYS)) return { ok: false, errors: c.errors };
  const a = input;

  const id = a['id'];
  if (id !== undefined && id !== null && c.str(id, 'id')) {
    if (!ALERT_ID_RE.test(id)) c.err('id', 'format', 'id must match [A-Za-z0-9_-]{1,36}');
    else if (RESERVED_ALERT_IDS.includes(id)) c.err('id', 'reserved', `id '${id}' is reserved`);
  }
  if (c.str(a['name'], 'name')) {
    const n = cpLength(a['name'].trim());
    if (n < 1 || n > LIMITS.name)
      c.err('name', 'length', `name must be 1..${LIMITS.name} characters`);
  }
  if (c.short(a['symbol'], 'symbol', LIMITS.symbol) && !PRINTABLE_RE.test(a['symbol']))
    c.err('symbol', 'format', 'symbol must contain printable characters only');
  if (c.str(a['interval'], 'interval') && !INTERVAL_RE.test(a['interval']))
    c.err('interval', 'format', 'interval must match ^[1-9][0-9]{0,5}[mhDWM]$');
  if (a['prepost'] !== undefined) c.bool(a['prepost'], 'prepost');
  const message = a['message'];
  if (message !== undefined && c.str(message, 'message') && cpLength(message) > LIMITS.message)
    c.err('message', 'length', `message must be at most ${LIMITS.message} characters`);
  const notify = checkNotify(c, a['notify']);
  const exp = a['expiresAt'];
  if (exp !== null && exp !== undefined && c.str(exp, 'expiresAt')) {
    if (!ISO_RE.test(exp) || !Number.isFinite(Date.parse(exp)))
      c.err('expiresAt', 'format', 'expiresAt must be an ISO 8601 date-time');
  }
  const status = a['status'];
  if (status !== undefined && status !== null) c.oneOf(status, ['active', 'paused'], 'status');
  const spec = upgradeAlertSpec(a['spec']);
  checkSpec(c, spec);

  if (c.errors.length) return { ok: false, errors: c.errors };
  const out = {
    name: (a['name'] as string).trim(),
    symbol: a['symbol'],
    interval: a['interval'],
    prepost: a['prepost'] ?? false,
    spec,
    message: message ?? '',
    notify,
    expiresAt: exp ?? null,
  } as AlertIn;
  if (typeof id === 'string') out.id = id;
  if (status === 'active' || status === 'paused') out.status = status;
  return { ok: true, alert: out };
}

function checkNotify(c: Checker, n: unknown): AlertNotify {
  const out: AlertNotify = { ...DEFAULT_NOTIFY };
  if (n === undefined) return out;
  if (!c.obj(n, 'notify', [...NOTIFY_BOOLS, 'webhookUrl'])) return out;
  for (const k of NOTIFY_BOOLS) {
    const v = n[k];
    if (v !== undefined && c.bool(v, `notify.${k}`)) out[k] = v;
  }
  const url = n['webhookUrl'];
  if (url === null || url === undefined) return out;
  if (!c.str(url, 'notify.webhookUrl')) return out;
  if (cpLength(url) > LIMITS.webhookUrl)
    c.err(
      'notify.webhookUrl',
      'length',
      `webhook URL must be at most ${LIMITS.webhookUrl} characters`,
    );
  else if (!WEBHOOK_URL_RE.test(url))
    c.err('notify.webhookUrl', 'format', 'webhook URL must start with http:// or https://');
  else out.webhookUrl = url;
  return out;
}

function checkSpec(c: Checker, spec: unknown): void {
  if (!c.obj(spec, 'spec', ['schemaVersion', 'left', 'condition', 'trigger'])) return;
  if (spec['schemaVersion'] !== 1)
    c.err('spec.schemaVersion', 'enum', 'spec.schemaVersion must be 1');
  checkSeries(c, spec['left'], 'spec.left');
  c.oneOf(spec['trigger'], TRIGGER_MODES, 'spec.trigger');
  checkCondition(c, spec['condition'], 'spec.condition');
  if (c.instances > LIMITS.instances)
    c.err('spec', 'too_large', `at most ${LIMITS.instances} indicator instances per spec`);
  const bytes = new TextEncoder().encode(JSON.stringify(spec)).length;
  if (bytes > LIMITS.specBytes)
    c.err('spec', 'too_large', `spec must be at most ${LIMITS.specBytes} bytes`);
}

const ALL_OPS: readonly string[] = [...CROSS_OPS, ...CHANNEL_OPS, ...MOVING_OPS];

function checkCondition(c: Checker, cond: unknown, path: string): void {
  if (!isObj(cond)) {
    c.err(path, cond === undefined ? 'required' : 'type', `${path} must be an object`);
    return;
  }
  const op = cond['op'];
  if (!c.oneOf(op, ALL_OPS, `${path}.op`)) return;
  const o = op as string;
  if ((CROSS_OPS as readonly string[]).includes(o)) {
    c.obj(cond, path, ['op', 'right']);
    checkValue(c, cond['right'], `${path}.right`);
  } else if ((CHANNEL_OPS as readonly string[]).includes(o)) {
    c.obj(cond, path, ['op', 'channel']);
    checkChannel(c, cond['channel'], `${path}.channel`);
  } else {
    c.obj(cond, path, ['op', 'amount', 'bars']);
    const amount = cond['amount'];
    if (c.num(amount, `${path}.amount`)) {
      if (!(amount > 0)) c.err(`${path}.amount`, 'range', 'amount must be > 0');
      else if (o.endsWith('Percent') && amount > LIMITS.maxPercent)
        c.err(`${path}.amount`, 'range', `percent amount must be <= ${LIMITS.maxPercent}`);
    }
    const bars = cond['bars'];
    if (
      c.num(bars, `${path}.bars`) &&
      (!Number.isInteger(bars) || bars < 1 || bars > LIMITS.maxBars)
    )
      c.err(`${path}.bars`, 'range', `bars must be an integer in 1..${LIMITS.maxBars}`);
  }
}

/** `kind` of a discriminated object, or null after reporting. */
function kindOf(c: Checker, v: unknown, path: string, kinds: readonly string[]): string | null {
  if (!isObj(v)) {
    c.err(path, v === undefined ? 'required' : 'type', `${path} must be an object`);
    return null;
  }
  return c.oneOf(v['kind'], kinds, `${path}.kind`) ? (v['kind'] as string) : null;
}

function checkChannel(c: Checker, ch: unknown, path: string): void {
  const kind = kindOf(c, ch, path, ['bounds', 'drawing']);
  if (!kind || !isObj(ch)) return;
  if (kind === 'bounds') {
    c.obj(ch, path, ['kind', 'upper', 'lower']);
    checkValue(c, ch['upper'], `${path}.upper`);
    checkValue(c, ch['lower'], `${path}.lower`);
    return;
  }
  c.obj(ch, path, ['kind', 'drawingId', 'scale']);
  const idOk = c.short(ch['drawingId'], `${path}.drawingId`);
  c.oneOf(ch['scale'], SCALES, `${path}.scale`);
  if (!idOk) return;
  const d = lookupDrawing(c, ch['drawingId'] as string, `${path}.drawingId`);
  if (!d) return;
  if (!isChannelTool(d.type) || d.points.length < (TOOL_POINTS[d.type] ?? Infinity))
    c.err(`${path}.drawingId`, 'drawing_unsupported', `drawing type '${d.type}' is not a channel`);
}

function lookupDrawing(c: Checker, id: string, path: string): DrawingInfo | null {
  const get = c.opts.drawing;
  if (!get) return null;
  const d = get(id);
  if (!d) {
    c.err(path, 'drawing_not_saved', 'drawing not saved');
    return null;
  }
  if (d.scope !== 'all' && c.symbol !== null && d.symbol !== c.symbol)
    c.err(path, 'drawing_symbol', `drawing belongs to ${d.symbol}`);
  return d;
}

function checkValue(c: Checker, v: unknown, path: string): void {
  const kind = kindOf(c, v, path, ['price', 'indicator', 'value', 'drawing']);
  if (!kind || !isObj(v)) return;
  if (kind === 'value') {
    c.obj(v, path, ['kind', 'value']);
    c.num(v['value'], `${path}.value`);
    return;
  }
  if (kind === 'drawing') {
    c.obj(v, path, ['kind', 'drawingId', 'part', 'scale']);
    const idOk = c.short(v['drawingId'], `${path}.drawingId`);
    const partOk = c.oneOf(v['part'], PARTS, `${path}.part`);
    c.oneOf(v['scale'], SCALES, `${path}.scale`);
    if (!idOk || !partOk) return;
    const d = lookupDrawing(c, v['drawingId'] as string, `${path}.drawingId`);
    if (!d) return;
    const part = v['part'] as 'line' | 'upper' | 'lower' | 'middle';
    if (!supportsPart(d.type, part) || d.points.length < (TOOL_POINTS[d.type] ?? Infinity))
      c.err(
        `${path}.part`,
        'drawing_unsupported',
        `drawing type '${d.type}' does not support part '${part}'`,
      );
    return;
  }
  checkSeries(c, v, path);
}

function checkSeries(c: Checker, v: unknown, path: string): void {
  const kind = kindOf(c, v, path, ['price', 'indicator']);
  if (!kind || !isObj(v)) return;
  if (kind === 'price') {
    c.obj(v, path, ['kind', 'field']);
    c.oneOf(v['field'], PRICE_FIELDS, `${path}.field`);
    return;
  }
  c.obj(v, path, ['kind', 'ref']);
  checkRef(c, v['ref'], `${path}.ref`);
}

/** One input value; returns false after reporting. */
function checkInput(c: Checker, v: unknown, path: string): boolean {
  if (isFiniteNum(v) || typeof v === 'boolean') return true;
  if (typeof v === 'string') {
    if (cpLength(v) <= LIMITS.inputString) return true;
    c.err(path, 'length', `string inputs are at most ${LIMITS.inputString} characters`);
    return false;
  }
  if (isObj(v)) {
    const before = c.errors.length;
    c.obj(v, path, ['instanceId', 'outputId']);
    if (isExternalRef(v))
      c.err(
        path,
        'reference',
        `sources on another symbol ('${v.instanceId}') are not supported in alerts`,
      );
    else if (c.str(v['instanceId'], `${path}.instanceId`) && !INSTANCE_ID_RE.test(v['instanceId']))
      c.err(`${path}.instanceId`, 'format', 'instance id must match [A-Za-z0-9_-]{1,64}');
    c.short(v['outputId'], `${path}.outputId`);
    return c.errors.length === before;
  }
  c.err(path, 'type', 'input values are finite numbers, booleans, strings or output refs');
  return false;
}

interface CheckedInstance {
  type: string;
  inputs: InputValueMap;
  path: string;
}

function checkRef(c: Checker, ref: unknown, path: string): void {
  if (!c.obj(ref, path, ['instances', 'instanceId', 'outputId', 'title'])) return;
  const insts = ref['instances'];
  const ip = `${path}.instances`;
  const ids = new Map<string, CheckedInstance>();
  let shapeOk = true;
  if (!Array.isArray(insts)) {
    c.err(ip, insts === undefined ? 'required' : 'type', `${ip} must be an array`);
    shapeOk = false;
  } else {
    c.instances += insts.length;
    if (insts.length < 1 || insts.length > LIMITS.instances) {
      c.err(ip, 'length', `${ip} must have 1..${LIMITS.instances} entries`);
      shapeOk = false;
    }
    insts.forEach((inst: unknown, k) => {
      const p = `${ip}.${k}`;
      const before = c.errors.length;
      if (!c.obj(inst, p, ['id', 'type', 'inputs'])) {
        shapeOk = false;
        return;
      }
      const id = inst['id'];
      if (c.str(id, `${p}.id`) && !INSTANCE_ID_RE.test(id))
        c.err(`${p}.id`, 'format', 'instance id must match [A-Za-z0-9_-]{1,64}');
      c.short(inst['type'], `${p}.type`);
      const inputs = inst['inputs'];
      if (isObj(inputs)) {
        const entries = Object.entries(inputs);
        if (entries.length > LIMITS.inputs)
          c.err(`${p}.inputs`, 'length', `at most ${LIMITS.inputs} inputs`);
        for (const [key, val] of entries) {
          const kp = `${p}.inputs.${key}`;
          if (cpLength(key) < 1 || cpLength(key) > LIMITS.shortId)
            c.err(kp, 'length', `input keys are 1..${LIMITS.shortId} characters`);
          checkInput(c, val, kp);
        }
      } else
        c.err(
          `${p}.inputs`,
          inputs === undefined ? 'required' : 'type',
          `${p}.inputs must be an object`,
        );
      if (c.errors.length !== before) {
        shapeOk = false;
        return;
      }
      if (ids.has(id as string)) {
        c.err(`${p}.id`, 'unique', `duplicate instance id '${id as string}'`);
        shapeOk = false;
        return;
      }
      ids.set(id as string, {
        type: inst['type'] as string,
        inputs: inputs as InputValueMap,
        path: p,
      });
    });
  }
  const target = ref['instanceId'];
  const outputId = ref['outputId'];
  let targetOk = c.str(target, `${path}.instanceId`);
  if (targetOk && !INSTANCE_ID_RE.test(target as string)) {
    c.err(`${path}.instanceId`, 'format', 'instance id must match [A-Za-z0-9_-]{1,64}');
    targetOk = false;
  }
  const outputOk = c.short(outputId, `${path}.outputId`);
  if (c.str(ref['title'], `${path}.title`) && cpLength(ref['title'] as string) > LIMITS.title)
    c.err(`${path}.title`, 'length', `title must be at most ${LIMITS.title} characters`);
  if (!shapeOk || !targetOk) return;
  if (!ids.has(target as string)) {
    c.err(`${path}.instanceId`, 'reference', `instance '${target as string}' is not in instances`);
    return;
  }
  // Every source ref must point into the list.
  let refsOk = true;
  for (const inst of ids.values()) {
    for (const [key, val] of Object.entries(inst.inputs)) {
      if (isOutputRef(val) && !ids.has(val.instanceId)) {
        c.err(
          `${inst.path}.inputs.${key}`,
          'reference',
          `source instance '${val.instanceId}' is not in instances`,
        );
        refsOk = false;
      }
    }
  }
  if (!refsOk) return;
  checkRegistry(c, ids, target as string, outputOk ? (outputId as string) : null, ip, path);
}

/**
 * TS-only checks: definitions exist and are usable in alerts (no repainting,
 * no other-symbol inputs), inputs resolve, outputs are plots, no cycle.
 */
function checkRegistry(
  c: Checker,
  ids: Map<string, CheckedInstance>,
  target: string,
  outputId: string | null,
  ip: string,
  path: string,
): void {
  let defsOk = true;
  for (const inst of ids.values()) {
    const def = c.registry.get(inst.type);
    if (!def) {
      c.err(`${inst.path}.type`, 'unknown_indicator', `unknown indicator '${inst.type}'`);
      defsOk = false;
      continue;
    }
    if (def.repaints) {
      c.err(
        `${inst.path}.type`,
        'unsupported_indicator',
        `${def.name} repaints past values and cannot be used in alerts`,
      );
      defsOk = false;
      continue;
    }
    if (Object.values(def.inputs).some((d) => d.kind === 'symbol')) {
      c.err(
        `${inst.path}.type`,
        'unsupported_indicator',
        `${def.name} uses another symbol's data and cannot be used in alerts`,
      );
      defsOk = false;
      continue;
    }
    try {
      const resolved = resolveInputs(def, inst.inputs);
      if (usesEvents(def, resolved)) {
        c.err(
          `${inst.path}.inputs`,
          'unsupported_indicator',
          `${def.name} with these inputs needs dividend, split or earnings events, which alerts do not have`,
        );
        defsOk = false;
      }
      if (usesFundamentals(def, resolved)) {
        c.err(
          `${inst.path}.inputs`,
          'unsupported_indicator',
          `${def.name} needs financial statements, which alerts do not have`,
        );
        defsOk = false;
      }
    } catch (e) {
      c.err(`${inst.path}.inputs`, 'invalid_inputs', e instanceof Error ? e.message : String(e));
      defsOk = false;
    }
  }
  if (!defsOk) return;
  const isPlot = (type: string, oid: string) =>
    c.registry.get(type)?.outputs.some((o) => o.id === oid && o.type === 'plot') === true;
  for (const inst of ids.values()) {
    for (const [key, val] of Object.entries(inst.inputs)) {
      if (!isOutputRef(val)) continue;
      const up = ids.get(val.instanceId);
      if (up && !isPlot(up.type, val.outputId))
        c.err(
          `${inst.path}.inputs.${key}`,
          'unknown_output',
          `'${val.outputId}' is not a plot of ${up.type}`,
        );
    }
  }
  const t = ids.get(target);
  if (t && outputId !== null && !isPlot(t.type, outputId))
    c.err(`${path}.outputId`, 'unknown_output', `'${outputId}' is not a plot of ${t.type}`);
  if (hasCycle(ids)) c.err(ip, 'cycle', 'indicator sources form a cycle');
}

function hasCycle(ids: Map<string, CheckedInstance>): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const val of Object.values(ids.get(id)?.inputs ?? {}))
      if (isOutputRef(val) && visit(val.instanceId)) return true;
    state.set(id, 2);
    return false;
  };
  for (const id of ids.keys()) if (visit(id)) return true;
  return false;
}

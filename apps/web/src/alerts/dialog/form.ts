/**
 * Form state of the alert dialog and its conversion to and from the wire
 * `AlertIn` (docs/alerts.md §5.2). Numbers stay text while editing; parse
 * problems come back as `ValidationError`s, everything else is `validateAlert`
 * (the same check the server runs).
 */
import {
  DEFAULT_NOTIFY,
  LIMITS,
  defaultAlertName,
  isChannelOp,
  isCrossOp,
  validateAlert,
  type Alert,
  type AlertIn,
  type AlertNotify,
  type ChannelOperand,
  type Condition,
  type ConditionOp,
  type DescribeNames,
  type DrawingLineOperand,
  type DrawingScaleMode,
  type SeriesOperand,
  type TriggerMode,
  type ValidateOptions,
  type ValidationError,
  type ValueOperand,
} from '@investopen/alerts';
import type { IndicatorRegistry } from '@investopen/indicators';

/** One side of a condition: a typed number or a source (price, indicator, drawing line). */
export type TargetForm =
  { kind: 'value'; text: string } | { kind: 'source'; operand: SeriesOperand | DrawingLineOperand };

export type ChannelForm =
  | { kind: 'bounds'; upper: TargetForm; lower: TargetForm }
  | { kind: 'drawing'; drawingId: string; scale: DrawingScaleMode };

export interface FormState {
  /** Set when editing; also kept for a retried create. */
  id?: string;
  /** '' = generated from the condition on save. */
  name: string;
  symbol: string;
  interval: string;
  prepost: boolean;
  left: SeriesOperand;
  op: ConditionOp;
  /** crossing, crossingUp/Down, greater, less. */
  right: TargetForm;
  /** The channel ops. */
  channel: ChannelForm;
  /** moving*: amount and bars (text). */
  amount: string;
  bars: string;
  trigger: TriggerMode;
  /** ISO 8601, null = open-ended. */
  expiresAt: string | null;
  /** Template; '' = default. */
  message: string;
  notify: AlertNotify;
  status: 'active' | 'paused';
}

export const emptyValue = (): TargetForm => ({ kind: 'value', text: '' });

/** Number as the form's text: no float noise, no exponent for ordinary prices. */
export const numberText = (n: number, decimals = 8): string =>
  Number.isFinite(n) ? String(Number(n.toFixed(decimals))) : '';

// ------------------------------------------------------------------ to spec

function parseNumber(text: string, path: string, errors: ValidationError[]): number {
  const t = text.trim();
  const n = t === '' ? NaN : Number(t);
  if (!Number.isFinite(n))
    errors.push({ path, code: 'type', message: t === '' ? 'Enter a number' : 'Not a number' });
  return n;
}

function targetToOperand(t: TargetForm, path: string, errors: ValidationError[]): ValueOperand {
  if (t.kind === 'source') return t.operand;
  return { kind: 'value', value: parseNumber(t.text, `${path}.value`, errors) };
}

function conditionOf(f: FormState, errors: ValidationError[]): Condition {
  const base = 'spec.condition';
  if (isCrossOp(f.op))
    return { op: f.op, right: targetToOperand(f.right, `${base}.right`, errors) };
  if (isChannelOp(f.op)) {
    let channel: ChannelOperand;
    if (f.channel.kind === 'drawing')
      channel = { kind: 'drawing', drawingId: f.channel.drawingId, scale: f.channel.scale };
    else
      channel = {
        kind: 'bounds',
        upper: targetToOperand(f.channel.upper, `${base}.channel.upper`, errors),
        lower: targetToOperand(f.channel.lower, `${base}.channel.lower`, errors),
      };
    return { op: f.op, channel };
  }
  const amount = parseNumber(f.amount, `${base}.amount`, errors);
  const bars = parseNumber(f.bars, `${base}.bars`, errors);
  if (Number.isFinite(bars) && !Number.isInteger(bars))
    errors.push({ path: `${base}.bars`, code: 'type', message: 'Bars must be a whole number' });
  return { op: f.op, amount, bars };
}

export interface ToAlertOptions extends ValidateOptions {
  registry?: IndicatorRegistry;
  /** Names for the generated alert name (drawing names, decimals). */
  names?: DescribeNames;
}

export type FormResult = { ok: true; alert: AlertIn } | { ok: false; errors: ValidationError[] };

/** Build and validate the wire body. An empty name becomes `defaultAlertName`. */
export function formToAlert(f: FormState, opts: ToAlertOptions = {}): FormResult {
  const errors: ValidationError[] = [];
  const condition = conditionOf(f, errors);
  if (errors.length) return { ok: false, errors };
  const symbol = f.symbol.trim();
  const spec = { schemaVersion: 1 as const, left: f.left, condition, trigger: f.trigger };
  const name =
    f.name.trim() ||
    Array.from(defaultAlertName({ symbol, spec }, opts.names)).slice(0, LIMITS.name).join('');
  const webhookUrl = f.notify.webhookUrl?.trim() || null;
  const body: AlertIn = {
    ...(f.id ? { id: f.id } : {}),
    name,
    symbol,
    interval: f.interval,
    prepost: f.prepost,
    spec,
    message: f.message,
    notify: { ...f.notify, webhookUrl },
    expiresAt: f.expiresAt,
    status: f.status,
  };
  return validateAlert(body, opts.registry, opts.drawing ? { drawing: opts.drawing } : {});
}

// ---------------------------------------------------------------- from spec

const operandToTarget = (op: ValueOperand): TargetForm =>
  op.kind === 'value'
    ? { kind: 'value', text: numberText(op.value) }
    : { kind: 'source', operand: op };

/** The form for a stored alert (edit) or one being cloned. */
export function alertToForm(a: AlertIn | Alert): FormState {
  const c = a.spec.condition;
  const form: FormState = {
    ...(a.id ? { id: a.id } : {}),
    name: a.name,
    symbol: a.symbol,
    interval: a.interval,
    prepost: a.prepost,
    left: a.spec.left,
    op: c.op,
    right: emptyValue(),
    channel: { kind: 'bounds', upper: emptyValue(), lower: emptyValue() },
    amount: '',
    bars: '1',
    trigger: a.spec.trigger,
    expiresAt: a.expiresAt,
    message: a.message,
    notify: { ...DEFAULT_NOTIFY, ...a.notify },
    status: a.status === 'paused' ? 'paused' : 'active',
  };
  if ('right' in c) form.right = operandToTarget(c.right);
  else if ('channel' in c)
    form.channel =
      c.channel.kind === 'drawing'
        ? { kind: 'drawing', drawingId: c.channel.drawingId, scale: c.channel.scale }
        : {
            kind: 'bounds',
            upper: operandToTarget(c.channel.upper),
            lower: operandToTarget(c.channel.lower),
          };
  else {
    form.amount = numberText(c.amount);
    form.bars = String(c.bars);
  }
  return form;
}

/** Copy for "Clone": new alert (no id), "<name> (copy)", paused until saved. */
export function cloneForm(a: Alert): FormState {
  const { id: _id, ...rest } = alertToForm(a);
  const suffix = ' (copy)';
  const name = Array.from(a.name)
    .slice(0, LIMITS.name - suffix.length)
    .join('');
  return { ...rest, name: `${name}${suffix}`, status: 'paused' };
}

/** Whether two forms describe the same alert (ignores the parts the op does not use). */
export function sameAlertForm(a: FormState, b: FormState): boolean {
  const x = formToAlert(a);
  const y = formToAlert(b);
  return x.ok && y.ok && JSON.stringify(x.alert) === JSON.stringify(y.alert);
}

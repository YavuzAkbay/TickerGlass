/**
 * Operand values for one sample (docs/alerts.md §2.1, §3.2): every distinct
 * operand (price field, indicator output by instance hash, drawing level) is
 * computed once per bar state and shared by all alerts of a series.
 */
import { createHash } from 'node:crypto';
import {
  drawingChannel,
  drawingLevel,
  DrawingLevelError,
  isMovingOp,
  orderBounds,
  priceValue,
  type AlertSpec,
  type DrawingLike,
  type IndicatorRef,
  type SampleValues,
  type ValueOperand,
} from '@tickerglass/alerts';
import { getIndicator, isOutputRef, type InputValueMap } from '@tickerglass/indicators';
import type { AnchorTimeline } from '@tickerglass/engine/node';

/** What operand evaluation needs from a series. */
export interface OperandEnv {
  readonly length: number;
  time(i: number): number;
  open(i: number): number;
  high(i: number): number;
  low(i: number): number;
  close(i: number): number;
  volume(i: number): number;
  /** Output `outputId` of runtime instance `hash` at chart index i (NaN if absent). */
  indicator(hash: string, outputId: string, i: number): number;
  drawing(id: string): DrawingLike | undefined;
  timeline(): AnchorTimeline;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export interface HashedInstance {
  /** Runtime instance id (content hash). */
  hash: string;
  type: string;
  /** Inputs with upstream references rewritten to hashes. */
  inputs: InputValueMap;
}

const refCache = new WeakMap<IndicatorRef, Map<string, HashedInstance>>();

/**
 * Content hash per instance id: `{type, inputs, upstream hashes}`, so two
 * alerts on "RSI 14" share one runtime instance. Throws on unknown ids/types.
 */
export function hashInstances(ref: IndicatorRef): Map<string, HashedInstance> {
  const known = refCache.get(ref);
  if (known) return known;
  const byId = new Map(ref.instances.map((i) => [i.id, i]));
  const out = new Map<string, HashedInstance>();
  const visiting = new Set<string>();
  const walk = (id: string): HashedInstance => {
    const done = out.get(id);
    if (done) return done;
    const inst = byId.get(id);
    if (!inst) throw new Error(`unknown indicator instance '${id}'`);
    if (visiting.has(id)) throw new Error(`indicator cycle at '${id}'`);
    visiting.add(id);
    const def = getIndicator(inst.type);
    if (!def) throw new Error(`unknown indicator '${inst.type}'`);
    const inputs: InputValueMap = { ...inst.inputs };
    for (const [key, d] of Object.entries(def.inputs)) {
      const v = inputs[key];
      if (d.kind === 'source' && isOutputRef(v)) {
        inputs[key] = { instanceId: walk(v.instanceId).hash, outputId: v.outputId };
      }
    }
    visiting.delete(id);
    const digest = createHash('sha1')
      .update(canonical({ type: inst.type, inputs }))
      .digest('hex')
      .slice(0, 16);
    const h: HashedInstance = { hash: `h${digest}`, type: inst.type, inputs };
    out.set(id, h);
    return h;
  };
  for (const inst of ref.instances) walk(inst.id);
  refCache.set(ref, out);
  return out;
}

/** Hashes of the target instance and all its upstream instances. */
export function refHashes(ref: IndicatorRef): HashedInstance[] {
  return [...hashInstances(ref).values()];
}

/** Hash of the instance an indicator operand reads. */
export function operandHash(ref: IndicatorRef): string {
  const h = hashInstances(ref).get(ref.instanceId);
  if (!h) throw new Error(`unknown indicator instance '${ref.instanceId}'`);
  return h.hash;
}

export function operandKey(op: ValueOperand): string {
  switch (op.kind) {
    case 'price':
      return `p:${op.field}`;
    case 'indicator':
      return `i:${operandHash(op.ref)}:${op.ref.outputId}`;
    case 'value':
      return `v:${op.value}`;
    case 'drawing':
      return `d:${op.drawingId}:${op.part}:${op.scale}`;
  }
}

/** Per-bar-state memo; call `clear()` whenever bars or drawings change. */
export class OperandCache {
  private readonly m = new Map<string, number>();
  private readonly ch = new Map<string, { upper: number; lower: number }>();

  clear(): void {
    this.m.clear();
    this.ch.clear();
  }

  value(env: OperandEnv, op: ValueOperand, i: number): number {
    if (op.kind === 'value') return op.value;
    const key = `${i}|${operandKey(op)}`;
    const hit = this.m.get(key);
    if (hit !== undefined) return hit;
    const v = this.compute(env, op, i);
    this.m.set(key, v);
    return v;
  }

  channel(
    env: OperandEnv,
    drawingId: string,
    scale: 'linear' | 'log',
    i: number,
  ): { upper: number; lower: number } {
    const key = `${i}|c:${drawingId}:${scale}`;
    const hit = this.ch.get(key);
    if (hit) return hit;
    const d = needDrawing(env, drawingId);
    const v = drawingChannel(d, scale, env.timeline(), env.time(i));
    this.ch.set(key, v);
    return v;
  }

  private compute(env: OperandEnv, op: ValueOperand, i: number): number {
    switch (op.kind) {
      case 'price':
        return priceValue(op.field, {
          open: env.open(i),
          high: env.high(i),
          low: env.low(i),
          close: env.close(i),
        });
      case 'indicator':
        return env.indicator(operandHash(op.ref), op.ref.outputId, i);
      case 'value':
        return op.value;
      case 'drawing':
        return drawingLevel(
          needDrawing(env, op.drawingId),
          op.part,
          op.scale,
          env.timeline(),
          env.time(i),
        );
    }
  }
}

function needDrawing(env: OperandEnv, id: string): DrawingLike {
  const d = env.drawing(id);
  if (!d) throw new DrawingLevelError('drawing not found');
  return d;
}

/** SampleValues of bar `i` (§2.1). Throws `DrawingLevelError` for drawing problems. */
export function buildValues(
  spec: AlertSpec,
  env: OperandEnv,
  cache: OperandCache,
  i: number,
): SampleValues {
  const out: SampleValues = {
    x: cache.value(env, spec.left, i),
    open: env.open(i),
    high: env.high(i),
    low: env.low(i),
    close: env.close(i),
    volume: env.volume(i),
  };
  const c = spec.condition;
  if ('right' in c) out.y = cache.value(env, c.right, i);
  else if ('channel' in c) {
    const ch = c.channel;
    if (ch.kind === 'bounds') {
      const b = orderBounds(cache.value(env, ch.upper, i), cache.value(env, ch.lower, i));
      out.upper = b.upper;
      out.lower = b.lower;
    } else {
      const b = cache.channel(env, ch.drawingId, ch.scale, i);
      out.upper = b.upper;
      out.lower = b.lower;
    }
  } else if (isMovingOp(c.op) && 'bars' in c) {
    const j = i - c.bars;
    out.ref = j < 0 ? NaN : cache.value(env, spec.left, j);
  }
  return out;
}

/** Drawing ids an alert's spec references. */
export function specDrawingIds(spec: AlertSpec): string[] {
  const ids = new Set<string>();
  const add = (op: ValueOperand) => {
    if (op.kind === 'drawing') ids.add(op.drawingId);
  };
  add(spec.left);
  const c = spec.condition;
  if ('right' in c) add(c.right);
  if ('channel' in c) {
    if (c.channel.kind === 'drawing') ids.add(c.channel.drawingId);
    else {
      add(c.channel.upper);
      add(c.channel.lower);
    }
  }
  return [...ids];
}

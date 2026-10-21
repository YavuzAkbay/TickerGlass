/** One alert revision: wraps `createAlertEvaluator`, builds operand values, renders the message. */
import { randomUUID } from 'node:crypto';
import {
  createAlertEvaluator,
  renderMessage,
  specRefs,
  warmupSince,
  type AlertDecision,
  type AlertEvaluator,
  type Alert,
  type AlertRuntimeState,
  type FireIn,
  type SampleKind,
} from '@tickerglass/alerts';
import type { SymbolInfo } from '@tickerglass/engine/node';
import {
  buildValues,
  refHashes,
  specDrawingIds,
  type HashedInstance,
  type OperandCache,
  type OperandEnv,
} from './operands';

export interface RunnerEnv extends OperandEnv {
  readonly info: SymbolInfo;
  /** Whether bar n-1 is closed. */
  readonly lastClosed: boolean;
  closeAt(i: number, graceS: number): number;
}

export interface FireJob {
  alertId: string;
  revision: number;
  body: FireIn;
}

export interface RunnerOptions {
  minRefireMs: number;
  graceS: number;
}

export class AlertRunner {
  readonly evaluator: AlertEvaluator;
  readonly instances: HashedInstance[];
  readonly drawingIds: string[];
  /** Activated at least once (its evaluator holds live state). */
  seeded = false;
  /** Earliest anchored-VWAP anchor (unix s) among the indicators, or null. */
  readonly since: number | null;
  /** Consecutive unexpected evaluation failures (reset on success). */
  failures = 0;
  /** Backoff after a failure: no evaluation before this clock time (ms). */
  blockedUntil = 0;
  /** The last seed attempt threw; retried once `blockedUntil` passed. */
  needsSeed = false;

  constructor(
    readonly alert: Alert,
    private readonly opts: RunnerOptions,
  ) {
    this.evaluator = createAlertEvaluator(alert, { minRefireMs: opts.minRefireMs });
    const seen = new Map<string, HashedInstance>();
    for (const ref of specRefs(alert.spec)) for (const h of refHashes(ref)) seen.set(h.hash, h);
    this.instances = [...seen.values()];
    this.drawingIds = specDrawingIds(alert.spec);
    let since: number | null = null;
    for (const ref of specRefs(alert.spec)) {
      const t = warmupSince(ref);
      if (t !== null) since = since === null ? t : Math.min(since, t);
    }
    this.since = since;
  }

  /** Needs history back to a drawing anchor or an anchored-VWAP anchor. */
  get deep(): boolean {
    return this.drawingIds.length > 0 || this.since !== null;
  }

  get id(): string {
    return this.alert.id;
  }
  get revision(): number {
    return this.alert.revision;
  }
  get done(): boolean {
    return this.evaluator.done;
  }

  /** Activation (§2.2). May throw `DrawingLevelError`. Returns a catch-up fire in close mode. */
  seed(
    env: RunnerEnv,
    cache: OperandCache,
    state: AlertRuntimeState | null,
    now: number,
  ): FireJob | null {
    this.seeded = true;
    const n = env.length;
    const spec = this.alert.spec;
    const last = n > 0 ? env.time(n - 1) : null;
    const prevTime = n > 1 ? env.time(n - 2) : null;
    let decision: AlertDecision | null;
    if (spec.trigger !== 'oncePerBarClose') {
      decision = this.evaluator.seed(state, { now, lastBarTime: last, previousBarTime: prevTime });
    } else {
      const li = env.lastClosed ? n - 1 : n - 2;
      const ctx = {
        now,
        lastBarTime: last,
        previousBarTime: prevTime,
        lastClosed:
          li >= 0
            ? {
                barIndex: li,
                barTime: env.time(li),
                values: buildValues(spec, env, cache, li),
                closedAt: env.closeAt(li, this.opts.graceS),
              }
            : null,
        beforeLastClosed:
          li >= 1
            ? {
                barIndex: li - 1,
                barTime: env.time(li - 1),
                values: buildValues(spec, env, cache, li - 1),
              }
            : null,
      };
      decision = this.evaluator.seed(state, ctx);
    }
    return decision ? this.toJob(env, decision) : null;
  }

  /** One sample of bar `i`. May throw `DrawingLevelError`. */
  sample(
    env: RunnerEnv,
    cache: OperandCache,
    kind: SampleKind,
    i: number,
    now: number,
    eventAt?: number,
  ): FireJob | null {
    if (this.evaluator.done) return null;
    if (this.evaluator.isExpired(now)) return null;
    const values = buildValues(this.alert.spec, env, cache, i);
    const d = this.evaluator.onSample({
      kind,
      barIndex: i,
      barTime: env.time(i),
      now,
      values,
      ...(eventAt !== undefined ? { eventAt } : {}),
    });
    return d ? this.toJob(env, d) : null;
  }

  private toJob(env: RunnerEnv, d: AlertDecision): FireJob {
    const a = this.alert;
    const message = renderMessage(a.message, {
      alert: a,
      symbol: env.info,
      barTime: d.barTime,
      values: d.values,
      firedAt: d.firedAt,
    });
    return {
      alertId: a.id,
      revision: a.revision,
      body: {
        fireId: randomUUID(),
        revision: a.revision,
        firedAt: new Date(d.firedAt).toISOString(),
        barTime: d.barTime,
        final: d.final,
        delayed: d.delayed,
        message,
        values: d.values,
        state: this.evaluator.state(),
      },
    };
  }
}

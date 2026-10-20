import { IndicatorRuntime, type Change, type IndicatorRegistry } from '@investopen/indicators/core';
import type { FromWorker, ResultChange, ToWorker } from './protocol';

export type Post = (msg: FromWorker, transfer: Transferable[]) => void;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The worker's message handler, independent of the Worker global so tests can
 * run it in-process. Owns one IndicatorRuntime (all indicators of one chart).
 */
export class WorkerCore {
  private readonly runtime: IndicatorRuntime;
  private revision = 0;
  /** `bars` messages handled (echoed in resync). */
  private barsSeen = 0;
  private tfMap: Record<string, string> = {};

  constructor(
    private readonly post: Post,
    registry?: IndicatorRegistry,
  ) {
    // Unknown values ('auto' before the first map) compute on chart bars.
    const resolveTimeframe = (tf: string) => this.tfMap[tf] ?? '';
    this.runtime = new IndicatorRuntime(
      registry ? { registry, resolveTimeframe } : { resolveTimeframe },
    );
  }

  /** Never throws: unexpected failures are posted as a fatal (id-less) error. */
  handle(msg: ToWorker): void {
    try {
      this.dispatch(msg);
    } catch (err) {
      this.post({ type: 'error', message: `Indicator worker: ${message(err)}` }, []);
    }
  }

  private dispatch(msg: ToWorker): void {
    switch (msg.type) {
      case 'timeframeMap':
        this.tfMap = { ...msg.map };
        this.emit(this.runtime.setResolveTimeframe((tf) => this.tfMap[tf] ?? ''));
        this.emitTimeframes();
        return;
      case 'context':
        this.emit(this.runtime.setContext(msg.context));
        return;
      case 'add':
        this.guarded(msg.spec.id, () => this.runtime.add(msg.spec));
        this.emitTimeframes();
        return;
      case 'setInputs':
        this.guarded(msg.id, () => this.runtime.setInputs(msg.id, msg.inputs));
        this.emitTimeframes();
        return;
      case 'remove':
        this.emit(this.runtime.remove(msg.id));
        this.emitTimeframes();
        return;
      case 'bars':
        this.barsSeen++;
        this.revision = msg.revision;
        if (msg.context) {
          // Apply the context over no bars (nothing to recompute), then compute once.
          const b = msg.bars;
          this.runtime.setBars({
            time: b.time.subarray(0, 0),
            open: b.open.subarray(0, 0),
            high: b.high.subarray(0, 0),
            low: b.low.subarray(0, 0),
            close: b.close.subarray(0, 0),
            volume: b.volume.subarray(0, 0),
          });
          this.runtime.setContext(msg.context);
        }
        this.emit(this.runtime.setBars(msg.bars));
        return;
      case 'bar': {
        // A bar of an older series would land on wrong indices.
        if (msg.revision !== this.revision) return;
        let changes: Change[];
        try {
          changes = this.runtime.updateBar(msg.index, msg.bar);
        } catch (err) {
          // Index mismatch: the host resends all bars. Anything else is fatal (handle()).
          if (!(err instanceof RangeError)) throw err;
          this.post({ type: 'resync', revision: this.revision, bars: this.barsSeen }, []);
          return;
        }
        this.emit(changes);
        return;
      }
      case 'tfBars':
        this.emit(this.runtime.setTimeframeBars(msg.tf, msg.bars));
        return;
      case 'tfBar':
        this.emit(this.runtime.updateTimeframeBar(msg.tf, msg.bar));
        return;
      case 'extBars':
        // Aligned to another series of displayed bars (a reset follows with new ones).
        if (msg.revision !== this.revision) return;
        this.emit(this.runtime.setExternal(msg.symbol, msg.bars));
        return;
      case 'extUpdate':
        if (msg.revision !== this.revision) return;
        this.emit(this.runtime.updateExternal(msg.symbol, msg.from, msg.bars));
        return;
      case 'clear':
        this.emit(this.runtime.clearData());
        return;
    }
  }

  /** Instance-level failures (cycle, invalid input) are reported against `id`. */
  private guarded(id: string, fn: () => Change[]): void {
    let changes: Change[];
    try {
      changes = fn();
    } catch (err) {
      this.post({ type: 'error', id, message: message(err) }, []);
      return;
    }
    this.emit(changes);
  }

  private emitTimeframes(): void {
    this.post({ type: 'timeframes', timeframes: this.runtime.requiredTimeframes() }, []);
    this.post({ type: 'symbols', symbols: this.runtime.requiredSymbols() }, []);
  }

  /** Copy the changed tails out of the runtime (its arrays are reused) and transfer them. */
  private emit(changes: Change[]): void {
    if (!changes.length) return;
    const length = this.runtime.length;
    const transfer: Transferable[] = [];
    const out: ResultChange[] = [];
    for (const ch of changes) {
      const res = this.runtime.result(ch.id);
      if (!res) continue;
      const from = Math.max(0, Math.min(ch.from, length));
      const values: Record<string, Float64Array> = {};
      const colors: Record<string, Uint8Array> = {};
      for (const [k, arr] of Object.entries(res.values)) {
        const copy = sliceTo(arr, from, length, NaN);
        values[k] = copy;
        transfer.push(copy.buffer);
      }
      for (const [k, arr] of Object.entries(res.colors)) {
        const copy = new Uint8Array(length - from);
        copy.set(arr.subarray(from, Math.min(arr.length, length)));
        colors[k] = copy;
        transfer.push(copy.buffer);
      }
      out.push({ id: ch.id, from, status: res.status, values, colors });
    }
    if (out.length)
      this.post({ type: 'results', revision: this.revision, length, changes: out }, transfer);
  }
}

/** [from, to) of `arr` as a new array; slots past `arr.length` get `fill`. */
function sliceTo(arr: Float64Array, from: number, to: number, fill: number): Float64Array {
  const out = new Float64Array(to - from);
  const end = Math.min(arr.length, to);
  if (end > from) out.set(arr.subarray(from, end));
  if (end < to) out.fill(fill, Math.max(0, end - from));
  return out;
}

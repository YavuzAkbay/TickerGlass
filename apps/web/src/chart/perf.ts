// Opt-in profiling (`?perf=1`): render stats from the engine and indicator
// compute times from the worker, shown in a small overlay per chart.

/** Indicator compute times of one chart. */
export interface ComputeStats {
  runs: number;
  lastMs: number;
  /** Mean of the last (up to) 60 runs. */
  avgMs: number;
}

const WINDOW = 60;

/** True when the page was opened with `?perf=1`. */
export function perfEnabled(search: string = globalThis.location?.search ?? ''): boolean {
  return new URLSearchParams(search).get('perf') === '1';
}

/** Rolling compute times of one chart's indicator worker. */
export class ComputeTimes {
  private readonly ms = new Float64Array(WINDOW);
  private runs = 0;

  record(ms: number): void {
    this.ms[this.runs % WINDOW] = ms;
    this.runs++;
  }

  stats(): ComputeStats {
    const n = Math.min(this.runs, WINDOW);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.ms[i]!;
    return {
      runs: this.runs,
      lastMs: this.runs ? this.ms[(this.runs - 1) % WINDOW]! : 0,
      avgMs: n ? sum / n : 0,
    };
  }
}

const computeTimes = new Map<string, ComputeTimes>();

/** The compute times of chart `id` (created on first use). */
export function computeTimesOf(id: string): ComputeTimes {
  let t = computeTimes.get(id);
  if (!t) {
    t = new ComputeTimes();
    computeTimes.set(id, t);
  }
  return t;
}

/** Chart `id` closed. */
export function dropComputeTimes(id: string): void {
  computeTimes.delete(id);
}

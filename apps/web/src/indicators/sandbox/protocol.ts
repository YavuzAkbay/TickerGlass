// Messages between the main thread and a user-script sandbox worker
// (docs/indicators.md §5a). The sandbox speaks the ToWorker subset an
// instance needs plus load/ping/check; it answers like the indicator worker
// (FromWorker) plus ack/loaded/compileError/checkResult.
import type { BarColumns } from '@tickerglass/engine';
import type {
  InputValueMap,
  RuntimeContext,
  UserScriptManifest,
} from '@tickerglass/indicators/core';
import type { FromWorker, ToWorker } from '../protocol';

/** Indicator-worker messages a sandbox handles (delegated to its WorkerCore). */
export type SandboxWorkerMessage = Extract<
  ToWorker,
  { type: 'context' | 'add' | 'setInputs' | 'remove' | 'bars' | 'bar' | 'clear' }
>;

export type SandboxMessage =
  | SandboxWorkerMessage
  /** Compile `source` as script `scriptId`; answered by `loaded` or `compileError`. */
  | { type: 'load'; source: string; apiVersion: 1; scriptId: string }
  /** Watchdog heartbeat: answered by its ack only. */
  | { type: 'ping' }
  /**
   * Live-consistency check of the loaded script (§4): full compute on `bars`
   * vs the last `liveBars` bars fed as live ticks. Answered by `checkResult`.
   */
  | {
      type: 'check';
      bars: BarColumns;
      context: RuntimeContext;
      inputs: InputValueMap;
      liveBars: number;
    }
  /** Dev/e2e only (`window.sandboxProbe`): run `code` as a script body, answer `probeResult`. */
  | { type: 'probe'; code: string };

/** Main thread -> sandbox. Every message carries a `seq`, acknowledged once handled. */
export interface ToSandbox {
  seq: number;
  msg: SandboxMessage;
}

export interface ProbeResult {
  ok: boolean;
  /** String form of the (awaited) return value. */
  value?: string;
  /** `Name: message` of the thrown value. */
  error?: string;
  /** Position in the user source (1-based), when the engine's stack has one. */
  line?: number;
  col?: number;
}

/** First output value where the live computation differs from the full one. */
export interface CheckMismatch {
  outputId: string;
  index: number;
  full: number;
  live: number;
}

export type FromSandbox =
  | FromWorker
  /** Message `seq` has been handled (everything it caused was posted before). */
  | { type: 'ack'; seq: number }
  | { type: 'loaded'; manifest: UserScriptManifest }
  /** `line`/`col`: position in the user source when the engine reported one. */
  | { type: 'compileError'; message: string; line?: number; col?: number }
  | { type: 'checkResult'; ok: boolean; mismatch?: CheckMismatch }
  | ({ type: 'probeResult'; seq: number } & ProbeResult);

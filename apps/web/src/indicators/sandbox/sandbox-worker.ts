// User-script sandbox worker entry (docs/plans/user-scripts.md §2), one per
// script instance. Served with a restrictive response CSP (vite.config.ts
// sandboxCsp(), docker/nginx.conf) and locked down in JS before any user code.
// Step 1 (spike): only the eval probe used by the dev hook `window.sandboxProbe`.
import { lockdown } from './lockdown';

/** Main thread -> sandbox. Every message carries a `seq`, acknowledged once handled. */
export interface ToSandbox {
  seq: number;
  msg: { type: 'probe'; code: string };
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

export type FromSandbox =
  | { type: 'ack'; seq: number }
  | ({ type: 'probeResult'; seq: number } & ProbeResult)
  | { type: 'error'; message: string };

const PARAMS = ['defineIndicator', 'NO_COLOR', 'PRICE_SOURCES', 'calendarPeriod'] as const;
const STACK_POSITION = /user-script\.js:(\d+):(\d+)/;

/** Compiles `source` as a strict-mode function body; line 1 of `source` is body line 1. */
function compile(source: string): (...args: unknown[]) => unknown {
  return new Function(...PARAMS, `"use strict";\n${source}\n//# sourceURL=user-script.js`) as (
    ...args: unknown[]
  ) => unknown;
}

/** Engine line/column of the user-script frame in `err`'s stack, if any. */
function stackPosition(err: unknown): { line: number; col: number } | null {
  try {
    const stack = (err as { stack?: unknown } | null)?.stack;
    const m = typeof stack === 'string' ? STACK_POSITION.exec(stack) : null;
    return m ? { line: Number(m[1]), col: Number(m[2]) } : null;
  } catch {
    return null; // a user object with a throwing `stack` getter
  }
}

/** Engine line of user line 1, measured with the real wrapper (differs between engines). */
function measureLineOffset(): number {
  try {
    compile('throw new Error();')();
  } catch (err) {
    const pos = stackPosition(err);
    if (pos) return pos.line - 1;
  }
  return 0;
}

function describe(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return String(value);
  } catch {
    return 'Unprintable value';
  }
}

async function probe(code: string): Promise<ProbeResult> {
  try {
    const value = await compile(code)(undefined, undefined, undefined, undefined);
    return { ok: true, value: describe(value) };
  } catch (err) {
    const pos = stackPosition(err);
    const at = pos ? { line: pos.line - lineOffset, col: pos.col } : {};
    return { ok: false, error: describe(err), ...at };
  }
}

async function handle(data: unknown): Promise<void> {
  const { seq, msg } = (data ?? {}) as Partial<ToSandbox>;
  if (typeof seq !== 'number') {
    post({ type: 'error', message: 'Sandbox: message without seq' } satisfies FromSandbox);
    return;
  }
  if (msg?.type === 'probe' && typeof msg.code === 'string') {
    const result = await probe(msg.code);
    post({ type: 'probeResult', seq, ...result } satisfies FromSandbox);
  } else {
    post({ type: 'error', message: 'Sandbox: unknown message' } satisfies FromSandbox);
  }
  post({ type: 'ack', seq } satisfies FromSandbox);
}

// Lockdown first: nothing below (or in user code) sees fetch, postMessage, timers, ...
const post = lockdown(self, (data) => void handle(data));
const lineOffset = measureLineOffset();

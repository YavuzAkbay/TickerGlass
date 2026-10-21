/**
 * Save flow of the script editor (docs/user-scripts.md):
 * acorn parse, a throwaway sandbox `load` for the manifest (or compile
 * error), the live-consistency `check` on the chart's bars, then persist.
 * Problems never throw: they come back as diagnostics. A failing Check only
 * warns. Imported by the editor chunk alone, which keeps `acorn` out of the
 * main bundle (it is loaded dynamically, on first use).
 */
import type { BarColumns } from '@tickerglass/engine';
import {
  USER_SCRIPT_API_VERSION,
  coerceInputs,
  definitionFromManifest,
  parseManifest,
  type RuntimeContext,
} from '@tickerglass/indicators';
import type { UserScript, UserScriptIn } from '../api/types';
import { copyColumns, secondsOf, type ChartHost } from '../indicators/controller';
import { createSandboxWorker, type SandboxPort } from '../indicators/sandbox/port';
import type { CheckMismatch, FromSandbox, SandboxMessage } from '../indicators/sandbox/protocol';
import { UserScriptConflict } from '../persist/userScripts';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  origin: 'syntax' | 'compile' | 'check';
  message: string;
  /** 1-based position in the source, when known. */
  line?: number;
  col?: number;
}

/** A throwaway sandbox must answer a `load` / `check` within this (the live watchdog allows the same). */
export const PROBE_TIMEOUT_MS = 10_000;
/** Compile error of a script whose `load` did not answer within `ms` (saved with no manifest). */
export const loadTimeoutMessage = (ms: number) =>
  `Script did not finish loading within ${ms / 1000} s (endless loop?)`;
/** The analysis failed because the script's `load` timed out (endless loop at the top level). */
export const loadTimedOut = (analysis: Analysis, ms = PROBE_TIMEOUT_MS) =>
  analysis.diagnostics.some((d) => d.origin === 'compile' && d.message === loadTimeoutMessage(ms));
/** The Check runs on the latest bars only: it must stay quick on long histories. */
export const MAX_CHECK_BARS = 5_000;
/** Fewer bars than this say nothing about live consistency. */
const MIN_CHECK_BARS = 2;

// ------------------------------------------------------------------ syntax

/** Syntax error of `source` (acorn: latest ECMAScript, `return` allowed at the top), or null. */
export async function parseSource(source: string): Promise<Diagnostic | null> {
  const { parse } = await import('acorn');
  try {
    parse(source, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
    return null;
  } catch (err) {
    const loc = (err as { loc?: { line?: unknown; column?: unknown } }).loc;
    const message = (err instanceof Error ? err.message : String(err))
      // acorn appends "(line:column)": the position is shown separately.
      .replace(/\s*\(\d+:\d+\)$/, '');
    const line = typeof loc?.line === 'number' ? loc.line : undefined;
    const col = typeof loc?.column === 'number' ? loc.column + 1 : undefined;
    return {
      severity: 'error',
      origin: 'syntax',
      message,
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {}),
    };
  }
}

// ------------------------------------------------------------------- probe

export interface CheckRequest {
  bars: BarColumns;
  context: RuntimeContext;
}

export type CheckOutcome =
  | { kind: 'ok' }
  | { kind: 'mismatch'; mismatch: CheckMismatch }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' };

export type ProbeOutcome =
  | {
      ok: true;
      /** As the sandbox compiled it (JSON), ready to store. */
      manifest: Record<string, unknown>;
      /** null: no check was requested. */
      check: CheckOutcome | null;
    }
  | { ok: false; error: { message: string; line?: number; col?: number } };

type Reply<T> = { value: T } | { failure: string } | 'timeout';

/**
 * Run `source` in a throwaway sandbox: `load`, then (if `request` gives bars)
 * `check` with the script's default inputs. The sandbox is terminated before
 * this returns, whatever happens, and each step has its own timeout.
 */
export async function probeScript(
  source: string,
  scriptId: string,
  request: (() => CheckRequest | null) | null,
  spawn: () => SandboxPort = createSandboxWorker,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  let port: SandboxPort;
  try {
    port = spawn();
  } catch (err) {
    return fail(`Sandbox worker failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let seq = 0;
  let waiter: ((r: Reply<FromSandbox>) => void) | null = null;
  let pick: ((m: FromSandbox) => boolean) | null = null;
  port.listen(
    (msg) => {
      if (waiter && pick?.(msg)) {
        const w = waiter;
        waiter = pick = null;
        w({ value: msg });
      }
    },
    (message) => {
      if (waiter) {
        const w = waiter;
        waiter = pick = null;
        w({ failure: message });
      }
    },
  );
  const ask = (
    msg: SandboxMessage,
    accept: (m: FromSandbox) => boolean,
    transfer: Transferable[] = [],
  ) =>
    new Promise<Reply<FromSandbox>>((resolve) => {
      const timer = setTimeout(() => {
        waiter = pick = null;
        resolve('timeout');
      }, timeoutMs);
      waiter = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      pick = accept;
      port.post({ seq: ++seq, msg }, transfer);
    });

  try {
    const loaded = await ask(
      { type: 'load', source, apiVersion: USER_SCRIPT_API_VERSION, scriptId },
      (m) => m.type === 'loaded' || m.type === 'compileError' || m.type === 'error',
    );
    if (loaded === 'timeout') return fail(loadTimeoutMessage(timeoutMs));
    if ('failure' in loaded) return fail(loaded.failure);
    const reply = loaded.value;
    if (reply.type === 'compileError')
      return {
        ok: false,
        error: {
          message: reply.message,
          ...(reply.line !== undefined ? { line: reply.line } : {}),
          ...(reply.col !== undefined ? { col: reply.col } : {}),
        },
      };
    if (reply.type !== 'loaded') return fail(textOf(reply));

    let manifest: Record<string, unknown>;
    let inputs;
    try {
      manifest = JSON.parse(JSON.stringify(reply.manifest)) as Record<string, unknown>;
      inputs = coerceInputs(definitionFromManifest(parseManifest(manifest)), {});
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    const req = request?.() ?? null;
    if (!req) return { ok: true, manifest, check: null };

    const bars = req.bars;
    const answer = await ask(
      { type: 'check', bars, context: req.context, inputs, liveBars: 50 },
      (m) => m.type === 'checkResult' || m.type === 'error',
      [
        bars.time.buffer,
        bars.open.buffer,
        bars.high.buffer,
        bars.low.buffer,
        bars.close.buffer,
        bars.volume.buffer,
      ],
    );
    return { ok: true, manifest, check: checkOutcome(answer) };
  } finally {
    port.terminate();
  }
}

const fail = (message: string): ProbeOutcome => ({ ok: false, error: { message } });

const textOf = (m: FromSandbox): string =>
  m.type === 'error' && typeof m.message === 'string'
    ? m.message
    : 'The script could not be loaded';

function checkOutcome(answer: Reply<FromSandbox>): CheckOutcome {
  if (answer === 'timeout') return { kind: 'timeout' };
  if ('failure' in answer) return { kind: 'error', message: answer.failure };
  const m = answer.value;
  if (m.type === 'checkResult')
    return m.ok || !m.mismatch ? { kind: 'ok' } : { kind: 'mismatch', mismatch: m.mismatch };
  return { kind: 'error', message: textOf(m) };
}

/** The Check's input from the current chart (its latest bars), or null with too little data. */
export function checkRequestOf(
  chart: Pick<ChartHost, 'store' | 'symbolInfo' | 'getInterval'> | null,
): CheckRequest | null {
  if (!chart) return null;
  const n = chart.store.length;
  if (n < MIN_CHECK_BARS) return null;
  const info = chart.symbolInfo;
  return {
    bars: copyColumns(chart.store, n, Math.max(0, n - MAX_CHECK_BARS)),
    context: {
      timezone: info?.timezone ?? 'UTC',
      session: info?.session ?? null,
      intervalSeconds: secondsOf(chart.getInterval()),
      timeframeSeconds: {},
    },
  };
}

// ---------------------------------------------------------------- analysis

export interface AnalyzeDeps {
  parse(source: string): Promise<Diagnostic | null>;
  /** The sandbox load (+ check); `withCheck` false for none. */
  probe(source: string, withCheck: boolean): Promise<ProbeOutcome>;
}

export interface Analysis {
  /** null: the script does not compile (it is still saved, as text). */
  manifest: Record<string, unknown> | null;
  diagnostics: Diagnostic[];
  /** A Check was requested but there was no chart data to run it on. */
  checkSkipped: boolean;
}

function checkDiagnostics(check: CheckOutcome): Diagnostic[] {
  const d = (severity: Severity, message: string): Diagnostic[] => [
    { severity, origin: 'check', message },
  ];
  switch (check.kind) {
    case 'ok':
      return d('info', 'Check passed: live updates match the full computation');
    case 'mismatch': {
      const { outputId, index, full, live } = check.mismatch;
      return d(
        'warning',
        `Check: output "${outputId}" differs at checked bar ${index} (full ${full}, live ${live}). ` +
          'The script probably keeps state outside ta.vars / ta primitives, so live bars will not match history.',
      );
    }
    case 'error':
      return d('warning', `Check could not run: ${check.message}`);
    case 'timeout':
      return d('warning', 'Check did not finish in time');
  }
}

/** Parse, load and (optionally) Check `source`. Never throws. */
export async function analyzeScript(
  source: string,
  deps: AnalyzeDeps,
  withCheck = true,
): Promise<Analysis> {
  const syntax = await deps.parse(source);
  if (syntax) return { manifest: null, diagnostics: [syntax], checkSkipped: false };
  const probe = await deps.probe(source, withCheck);
  if (!probe.ok)
    return {
      manifest: null,
      diagnostics: [{ severity: 'error', origin: 'compile', ...probe.error }],
      checkSkipped: false,
    };
  if (!withCheck) return { manifest: probe.manifest, diagnostics: [], checkSkipped: false };
  if (!probe.check)
    return {
      manifest: probe.manifest,
      diagnostics: [
        { severity: 'info', origin: 'check', message: 'Check skipped: the chart has no data' },
      ],
      checkSkipped: true,
    };
  return {
    manifest: probe.manifest,
    diagnostics: checkDiagnostics(probe.check),
    checkSkipped: false,
  };
}

export interface SaveDeps extends AnalyzeDeps {
  save(id: string, input: UserScriptIn, opts: { overwrite?: boolean }): Promise<UserScript>;
  /** The analysis is ready (before persisting, so it shows even if persisting fails). */
  onAnalysis?(analysis: Analysis): void;
}

export interface SaveOptions {
  overwrite?: boolean;
  /** Persist this analysis instead of running a new one (retry after a conflict). */
  analysis?: Analysis;
}

/**
 * Analyze and persist `{name, source, manifest | null, apiVersion}`. A script
 * that does not compile is saved too (manifest null). Persisting errors
 * (`UserScriptConflict`, offline) propagate to the caller.
 */
export async function saveScript(
  id: string,
  name: string,
  source: string,
  deps: SaveDeps,
  opts: SaveOptions = {},
): Promise<{ saved: UserScript; analysis: Analysis }> {
  const analysis = opts.analysis ?? (await analyzeScript(source, deps));
  if (!opts.analysis) deps.onAnalysis?.(analysis);
  const saved = await deps.save(
    id,
    { name, source, manifest: analysis.manifest, apiVersion: USER_SCRIPT_API_VERSION },
    opts.overwrite ? { overwrite: true } : {},
  );
  return { saved, analysis };
}

// ------------------------------------------------------------------ rename

export interface RenameDeps {
  save(id: string, input: UserScriptIn, opts: { overwrite?: boolean }): Promise<UserScript>;
  /** 409: offer "Overwrite", which renames the version stored elsewhere (`err.current`). */
  onConflict(err: UserScriptConflict, overwrite: () => Promise<void>): void;
  onError(err: unknown): void;
}

/**
 * Store `script` under `name`, keeping its source and manifest. On a conflict
 * the overwrite renames `err.current` (what the server has now), never this
 * tab's possibly stale copy. Never throws.
 */
export async function renameScript(
  script: UserScript,
  name: string,
  deps: RenameDeps,
  overwrite = false,
): Promise<void> {
  const input: UserScriptIn = {
    name,
    source: script.source,
    manifest: script.manifest,
    apiVersion: script.apiVersion,
  };
  try {
    await deps.save(script.id, input, overwrite ? { overwrite } : {});
  } catch (err) {
    if (err instanceof UserScriptConflict)
      deps.onConflict(err, () => renameScript(err.current, name, deps, true));
    else deps.onError(err);
  }
}

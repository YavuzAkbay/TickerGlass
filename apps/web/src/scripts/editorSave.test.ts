import type { BarColumns } from '@investopen/engine';
import { probeLineOffset } from '@investopen/indicators/core';
import { describe, expect, it, vi } from 'vitest';
import type { UserScript, UserScriptIn } from '../api/types';
import type { SandboxPort } from '../indicators/sandbox/port';
import type { FromSandbox, ToSandbox } from '../indicators/sandbox/protocol';
import { SandboxCore } from '../indicators/sandbox/sandboxCore';
import { UserScriptConflict } from '../persist/userScripts';
import {
  MAX_CHECK_BARS,
  PROBE_TIMEOUT_MS,
  analyzeScript,
  checkRequestOf,
  loadTimedOut,
  loadTimeoutMessage,
  parseSource,
  probeScript,
  renameScript,
  saveScript,
  type AnalyzeDeps,
  type CheckRequest,
  type ProbeOutcome,
  type SaveDeps,
} from './editorSave';
import { NEW_SCRIPT_TEMPLATE } from './editorText';

const CONTEXT = { timezone: 'UTC', session: null, intervalSeconds: 60, timeframeSeconds: {} };

function bars(n: number): BarColumns {
  const c = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    c.time[i] = 1_700_000_000 + i * 60;
    c.open[i] = c.high[i] = c.low[i] = c.close[i] = 10 + Math.sin(i / 3);
    c.volume[i] = 1;
  }
  return c;
}
const request = (): CheckRequest => ({ bars: bars(120), context: CONTEXT });

/** A sandbox backed by a real SandboxCore; replies are delivered at once. */
class CoreSandbox implements SandboxPort {
  terminated = false;
  posted: ToSandbox[] = [];
  private onMessage: ((m: FromSandbox) => void) | null = null;
  private core = new SandboxCore((msg) => this.onMessage?.(msg as FromSandbox), probeLineOffset());
  post(data: ToSandbox) {
    this.posted.push(data);
    this.core.handle(data);
  }
  listen(onMessage: (m: FromSandbox) => void) {
    this.onMessage = onMessage;
  }
  terminate() {
    this.terminated = true;
  }
}

/** A sandbox that never answers. */
class SilentSandbox implements SandboxPort {
  terminated = false;
  failure: ((m: string) => void) | null = null;
  post() {}
  listen(_m: (m: FromSandbox) => void, onFailure: (m: string) => void) {
    this.failure = onFailure;
  }
  terminate() {
    this.terminated = true;
  }
}

const good = (title = 'MA') => `defineIndicator({
  name: 'My SMA',
  shortName: 'MySMA',
  category: 'movingAverage',
  overlay: true,
  inputs: { length: { kind: 'int', label: 'Length', default: 3, min: 1 } },
  outputs: [{ type: 'plot', id: 'ma', title: '${title}', kind: 'line', color: '#4f6bed' }],
  setup({ inputs, ta }) {
    const avg = ta.sma(inputs.length);
    return (c) => c.set('ma', avg.update(c.close[c.i]));
  },
});`;

// State kept in a closure instead of ta.vars: live updates diverge from the full computation.
const closureState = `let n = 0;
defineIndicator({
  name: 'Bad',
  shortName: 'Bad',
  category: 'other',
  overlay: false,
  inputs: {},
  outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#4f6bed' }],
  setup() {
    return (c) => c.set('v', n++);
  },
});`;

describe('parseSource (acorn)', () => {
  it('accepts valid scripts, including a top-level return', async () => {
    expect(await parseSource(NEW_SCRIPT_TEMPLATE)).toBeNull();
    expect(await parseSource('return 1;')).toBeNull();
    expect(await parseSource('const a = 1n ** 2n; a?.b ?? 1;')).toBeNull();
  });

  it("reports the syntax error with a 1-based line and column, without acorn's suffix", async () => {
    const d = await parseSource('const a = 1;\nconst b = ;\n');
    expect(d).toMatchObject({ severity: 'error', origin: 'syntax', line: 2, col: 11 });
    expect(d?.message).not.toMatch(/\(\d+:\d+\)/);
    expect(d?.message).toMatch(/Unexpected token/);
  });
});

describe('probeScript', () => {
  it('loads a script and returns its manifest as JSON; terminates the sandbox', async () => {
    const sb = new CoreSandbox();
    const out = await probeScript(good(), 's1', null, () => sb);
    expect(out).toMatchObject({ ok: true, check: null });
    if (!out.ok) throw new Error('unreachable');
    expect(out.manifest).toMatchObject({ id: 'user:s1', name: 'My SMA' });
    expect(JSON.parse(JSON.stringify(out.manifest))).toEqual(out.manifest);
    expect(sb.posted.map((p) => p.msg.type)).toEqual(['load']);
    expect(sb.terminated).toBe(true);
  });

  it('reports a compile error with its line', async () => {
    const sb = new CoreSandbox();
    const out = await probeScript('defineIndicator({});\n', 's1', null, () => sb);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('unreachable');
    expect(out.error.message).toBeTruthy();
    expect(sb.terminated).toBe(true);
  });

  it('runs the Check on the given bars: a correct script passes', async () => {
    const sb = new CoreSandbox();
    const out = await probeScript(good(), 's1', request, () => sb);
    expect(out).toMatchObject({ ok: true, check: { kind: 'ok' } });
    expect(sb.posted.map((p) => p.msg.type)).toEqual(['load', 'check']);
    expect(sb.terminated).toBe(true);
  });

  it('a closure-state script fails the Check with a mismatch', async () => {
    const out = await probeScript(closureState, 's1', request, () => new CoreSandbox());
    expect(out).toMatchObject({ ok: true, check: { kind: 'mismatch' } });
  });

  it('no bars: no check', async () => {
    const out = await probeScript(
      good(),
      's1',
      () => null,
      () => new CoreSandbox(),
    );
    expect(out).toMatchObject({ ok: true, check: null });
  });

  it('times out a sandbox that never answers, and terminates it', async () => {
    vi.useFakeTimers();
    try {
      const sb = new SilentSandbox();
      const p = probeScript(good(), 's1', null, () => sb, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      const out = await p;
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.error.message).toBe(loadTimeoutMessage(1000));
      expect(loadTimeoutMessage(PROBE_TIMEOUT_MS)).toBe(
        'Script did not finish loading within 10 s (endless loop?)',
      );
      expect(sb.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a Check that never answers times out but keeps the manifest', async () => {
    vi.useFakeTimers();
    try {
      let sb: SandboxPort | null = null;
      // Answers load, then goes silent.
      const real = new CoreSandbox();
      sb = {
        post: (d) => {
          if (d.msg.type === 'load') real.post(d);
        },
        listen: (m) => real.listen(m),
        terminate: () => real.terminate(),
      };
      const p = probeScript(good(), 's1', request, () => sb!, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await p).toMatchObject({ ok: true, check: { kind: 'timeout' } });
      expect(real.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a worker failure and a failing spawn become errors', async () => {
    const sb = new SilentSandbox();
    const p = probeScript(good(), 's1', null, () => sb);
    sb.failure?.('Sandbox worker failed: boom');
    expect(await p).toEqual({ ok: false, error: { message: 'Sandbox worker failed: boom' } });
    expect(sb.terminated).toBe(true);
    const out = await probeScript(good(), 's1', null, () => {
      throw new Error('no workers');
    });
    expect(out.ok === false && out.error.message).toMatch(/no workers/);
  });
});

describe('checkRequestOf', () => {
  const chart = (n: number) =>
    ({
      store: { ...bars(n), length: n },
      symbolInfo: { timezone: 'America/New_York', session: null },
      getInterval: () => '5m',
    }) as unknown as Parameters<typeof checkRequestOf>[0];

  it('copies the latest bars with the chart context', () => {
    const c = chart(10);
    const r = checkRequestOf(c);
    expect(r?.bars.time).toEqual(c!.store.time);
    expect(r?.bars.time).not.toBe(c!.store.time);
    expect(r?.context).toMatchObject({ timezone: 'America/New_York', intervalSeconds: 300 });
  });

  it('caps long histories to the latest bars', () => {
    const c = chart(MAX_CHECK_BARS + 25);
    const r = checkRequestOf(c);
    expect(r?.bars.time).toHaveLength(MAX_CHECK_BARS);
    expect(r?.bars.time[0]).toBe(c!.store.time[25]);
  });

  it('nothing to check without a chart or data', () => {
    expect(checkRequestOf(null)).toBeNull();
    expect(checkRequestOf(chart(1))).toBeNull();
  });
});

const okProbe = (check: ProbeOutcome) => vi.fn<AnalyzeDeps['probe']>(async () => check);
const manifest = { id: 'user:s1', name: 'X' };

describe('analyzeScript', () => {
  it('a syntax error stops before the sandbox', async () => {
    const probe = vi.fn();
    const a = await analyzeScript('x', {
      parse: async () => ({ severity: 'error', origin: 'syntax', message: 'bad', line: 2, col: 3 }),
      probe,
    });
    expect(a.manifest).toBeNull();
    expect(a.diagnostics).toEqual([
      { severity: 'error', origin: 'syntax', message: 'bad', line: 2, col: 3 },
    ]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('a compile error carries its position', async () => {
    const a = await analyzeScript('x', {
      parse: async () => null,
      probe: okProbe({ ok: false, error: { message: 'nope', line: 7 } }),
    });
    expect(a.manifest).toBeNull();
    expect(a.diagnostics).toEqual([
      { severity: 'error', origin: 'compile', message: 'nope', line: 7 },
    ]);
  });

  it('Check results: pass is info, mismatch and failures only warn', async () => {
    const run = (check: ProbeOutcome) =>
      analyzeScript('x', { parse: async () => null, probe: okProbe(check) });
    const pass = await run({ ok: true, manifest, check: { kind: 'ok' } });
    expect(pass).toMatchObject({ manifest, diagnostics: [{ severity: 'info', origin: 'check' }] });
    const bad = await run({
      ok: true,
      manifest,
      check: { kind: 'mismatch', mismatch: { outputId: 'v', index: 3, full: 1, live: 2 } },
    });
    expect(bad.manifest).toBe(manifest);
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'warning', origin: 'check' });
    expect(bad.diagnostics[0]?.message).toMatch(/"v".*bar 3/);
    for (const check of [{ kind: 'timeout' }, { kind: 'error', message: 'x' }] as const) {
      const a = await run({ ok: true, manifest, check });
      expect(a.manifest).toBe(manifest);
      expect(a.diagnostics[0]?.severity).toBe('warning');
    }
  });

  it('no chart data: the Check is skipped, not failed', async () => {
    const a = await analyzeScript('x', {
      parse: async () => null,
      probe: okProbe({ ok: true, manifest, check: null }),
    });
    expect(a).toMatchObject({ manifest, checkSkipped: true });
    expect(a.diagnostics[0]?.severity).toBe('info');
  });

  it('asks the sandbox for a check only when wanted', async () => {
    const probe = okProbe({ ok: true, manifest, check: null });
    await analyzeScript('x', { parse: async () => null, probe }, false);
    expect(probe).toHaveBeenCalledWith('x', false);
  });
});

describe('saveScript', () => {
  const stored = (input: UserScriptIn): UserScript => ({
    id: 's1',
    ...input,
    revision: 1,
    createdAt: '',
    updatedAt: '',
  });
  function deps(over: Partial<SaveDeps> = {}) {
    const save = vi.fn(async (_id: string, input: UserScriptIn) => stored(input));
    const d: SaveDeps = {
      parse: async () => null,
      probe: okProbe({ ok: true, manifest, check: { kind: 'ok' } }),
      save,
      ...over,
    };
    return { d, save };
  }

  it('persists name, source, manifest and apiVersion', async () => {
    const { d, save } = deps();
    const { saved, analysis } = await saveScript('s1', 'Mine', 'src', d);
    expect(save).toHaveBeenCalledWith(
      's1',
      { name: 'Mine', source: 'src', manifest, apiVersion: 1 },
      {},
    );
    expect(saved.manifest).toBe(manifest);
    expect(analysis.diagnostics).toHaveLength(1);
  });

  it('a failing Check still saves', async () => {
    const { d, save } = deps({
      probe: okProbe({ ok: true, manifest, check: { kind: 'timeout' } }),
    });
    await saveScript('s1', 'n', 'src', d);
    expect(save).toHaveBeenCalledOnce();
  });

  it('a script whose load times out is saved with manifest null and says why', async () => {
    const message = loadTimeoutMessage(PROBE_TIMEOUT_MS);
    const { d, save } = deps({ probe: okProbe({ ok: false, error: { message } }) });
    const { analysis } = await saveScript('s1', 'n', 'src', d);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ manifest: null });
    expect(analysis.diagnostics).toEqual([{ severity: 'error', origin: 'compile', message }]);
    expect(loadTimedOut(analysis)).toBe(true);
    const other = { manifest: null, diagnostics: [], checkSkipped: false };
    expect(loadTimedOut(other)).toBe(false);
  });

  it('a script that does not compile is saved with manifest null', async () => {
    const { d, save } = deps({
      parse: async () => ({ severity: 'error', origin: 'syntax', message: 'bad', line: 1 }),
    });
    await saveScript('s1', 'n', 'src', d);
    expect(save.mock.calls[0]?.[1]).toMatchObject({ manifest: null, source: 'src' });
  });

  it('reports the analysis before persisting, even if persisting fails', async () => {
    const seen: unknown[] = [];
    const err = new Error('conflict');
    const { d } = deps({
      save: vi.fn(async () => {
        throw err;
      }),
      onAnalysis: (a) => seen.push(a.manifest),
    });
    await expect(saveScript('s1', 'n', 'src', d)).rejects.toBe(err);
    expect(seen).toEqual([manifest]);
  });

  it('overwrite reuses a given analysis and passes the flag', async () => {
    const probe = vi.fn();
    const { d, save } = deps({ probe });
    const analysis = { manifest, diagnostics: [], checkSkipped: false };
    await saveScript('s1', 'n', 'src', d, { overwrite: true, analysis });
    expect(probe).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith('s1', expect.objectContaining({ manifest }), {
      overwrite: true,
    });
  });
});

describe('renameScript', () => {
  const script = (over: Partial<UserScript> = {}): UserScript => ({
    id: 's1',
    name: 'Old',
    source: 'mine',
    manifest,
    apiVersion: 1,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over,
  });

  it('keeps source and manifest, changes the name', async () => {
    const save = vi.fn(async (_id: string, input: UserScriptIn) => script(input));
    await renameScript(script(), 'New', { save, onConflict: vi.fn(), onError: vi.fn() });
    expect(save).toHaveBeenCalledWith(
      's1',
      { name: 'New', source: 'mine', manifest, apiVersion: 1 },
      {},
    );
  });

  it("overwrite after a conflict renames the server's version, not the stale copy", async () => {
    const theirs = script({ name: 'Theirs', source: 'theirs', manifest: null, revision: 5 });
    const save = vi
      .fn<(id: string, input: UserScriptIn, opts: { overwrite?: boolean }) => Promise<UserScript>>()
      .mockRejectedValueOnce(new UserScriptConflict(theirs))
      .mockImplementation(async (_id, input) => script(input));
    let overwrite: (() => Promise<void>) | null = null;
    const onConflict = vi.fn((err: UserScriptConflict, run: () => Promise<void>) => {
      expect(err.current).toBe(theirs);
      overwrite = run;
    });
    const onError = vi.fn();
    await renameScript(script(), 'New', { save, onConflict, onError });
    expect(onConflict).toHaveBeenCalledOnce();
    await overwrite!();
    expect(save).toHaveBeenLastCalledWith(
      's1',
      { name: 'New', source: 'theirs', manifest: null, apiVersion: 1 },
      { overwrite: true },
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('other failures go to onError', async () => {
    const err = new Error('offline');
    const onError = vi.fn();
    await renameScript(script(), 'New', {
      save: async () => {
        throw err;
      },
      onConflict: vi.fn(),
      onError,
    });
    expect(onError).toHaveBeenCalledWith(err);
  });
});

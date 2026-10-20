/**
 * Pure helpers of the script editor (dialogs/ScriptEditorDialog.tsx): line
 * numbers, caret positions, Tab handling and script naming. No DOM, no React.
 */
import type { IndicatorState } from '../indicators/model';
import { USER_SCRIPT_PREFIX } from '@investopen/indicators';

/** The "New script" template: the SMA cross of docs/user-scripts.md section 1. */
export const NEW_SCRIPT_TEMPLATE = `// SMA cross: two moving averages and a marker where the fast one crosses the slow one.
defineIndicator({
  name: 'SMA Cross',
  shortName: 'SMA X',
  category: 'trend',
  overlay: true,
  inputs: {
    fast: { kind: 'int', label: 'Fast length', default: 9, min: 1, max: 500 },
    slow: { kind: 'int', label: 'Slow length', default: 21, min: 2, max: 500 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'plot', id: 'fast', title: 'Fast', kind: 'line', color: '#4f6bed' },
    { type: 'plot', id: 'slow', title: 'Slow', kind: 'line', color: '#f2a93b' },
    {
      type: 'shape',
      id: 'up',
      title: 'Cross up',
      shape: 'triangleUp',
      location: 'belowBar',
      color: '#18a383',
    },
    {
      type: 'shape',
      id: 'down',
      title: 'Cross down',
      shape: 'triangleDown',
      location: 'aboveBar',
      color: '#e5484d',
    },
  ],
  setup({ inputs, ta }) {
    const fast = ta.sma(inputs.fast);
    const slow = ta.sma(inputs.slow);
    // Anything carried from one bar to the next lives in ta.vars (or another ta primitive).
    const prev = ta.vars({ diff: NaN });
    return (c) => {
      const x = c.src.source[c.i];
      const f = fast.update(x);
      const s = slow.update(x);
      const diff = f - s;
      c.set('fast', f);
      c.set('slow', s);
      if (prev.diff <= 0 && diff > 0) c.set('up', c.low[c.i]);
      if (prev.diff >= 0 && diff < 0) c.set('down', c.high[c.i]);
      prev.diff = diff;
    };
  },
});
`;

/** Scripts store the names of the list as 1-100 characters (server limit). */
export const MAX_SCRIPT_NAME = 100;

/** Number of lines (an empty text, or one ending in a newline, still has a last line). */
export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Line-number gutter content: "1\n2\n...\nN", one number per line of `text`. */
export function gutterText(text: string): string {
  const n = lineCount(text);
  const out: number[] = [];
  for (let i = 1; i <= n; i++) out.push(i);
  return out.join('\n');
}

/** 1-based line and column of a character offset (clamped into the text). */
export function positionOf(text: string, offset: number): { line: number; col: number } {
  const end = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < end; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: end - start + 1 };
}

/**
 * Character offset of 1-based `line` / `col`. A line past the end maps to the
 * end of the text, a column past the end of its line to the line's end.
 */
export function offsetOf(text: string, line: number, col = 1): number {
  const wanted = Math.max(1, Math.floor(line));
  let start = 0;
  for (let l = 1; l < wanted; l++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return text.length;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  const end = nl < 0 ? text.length : nl;
  return Math.min(end, start + Math.max(0, Math.floor(col) - 1));
}

export const INDENT = '  ';

/** Tab: replace the selection `[start, end)` by two spaces, caret after them. */
export function insertIndent(
  text: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  return {
    text: text.slice(0, start) + INDENT + text.slice(end),
    caret: start + INDENT.length,
  };
}

/** `base`, or `base 2`, `base 3`... the first not in `taken` (case-insensitive). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const clip = (s: string) => s.slice(0, MAX_SCRIPT_NAME);
  if (!used.has(base.toLowerCase())) return clip(base);
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const name = base.slice(0, MAX_SCRIPT_NAME - suffix.length) + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** Name of a copy: "X copy", "X copy 2"... */
export function copyName(name: string, taken: readonly string[]): string {
  return uniqueName(`${name.slice(0, MAX_SCRIPT_NAME - 5)} copy`, taken);
}

/** Instances (of the current layout) that run script `scriptId`. */
export function instancesOfScript(
  instances: readonly IndicatorState[],
  scriptId: string,
): IndicatorState[] {
  return instances.filter((i) => i.type === USER_SCRIPT_PREFIX + scriptId);
}

/** A fresh script id: matches the server's `[A-Za-z0-9_-]{1,36}`. */
export function newScriptId(): string {
  return crypto.randomUUID();
}

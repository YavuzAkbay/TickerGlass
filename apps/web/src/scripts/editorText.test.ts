import { describe, expect, it } from 'vitest';
import type { IndicatorState } from '../indicators/model';
import {
  MAX_SCRIPT_NAME,
  NEW_SCRIPT_TEMPLATE,
  copyName,
  gutterText,
  insertIndent,
  instancesOfScript,
  lineCount,
  newScriptId,
  offsetOf,
  positionOf,
  uniqueName,
} from './editorText';

describe('line numbers', () => {
  it('counts lines, a trailing newline starts another', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\nb\n')).toBe(3);
    expect(lineCount('\n\n')).toBe(3);
  });

  it('gutter has one number per line, matching the text', () => {
    expect(gutterText('')).toBe('1');
    expect(gutterText('a\nb\nc')).toBe('1\n2\n3');
    const src = NEW_SCRIPT_TEMPLATE;
    expect(gutterText(src).split('\n')).toHaveLength(lineCount(src));
  });
});

describe('line / offset mapping', () => {
  const text = 'ab\n\ncdef\ng';
  it('offsetOf maps 1-based line and column', () => {
    expect(offsetOf(text, 1)).toBe(0);
    expect(offsetOf(text, 1, 2)).toBe(1);
    expect(offsetOf(text, 2)).toBe(3);
    expect(offsetOf(text, 3, 3)).toBe(6);
    expect(offsetOf(text, 4)).toBe(9);
  });

  it('clamps a column to the line end and a line past the end to the text end', () => {
    expect(offsetOf(text, 1, 99)).toBe(2);
    expect(offsetOf(text, 3, 99)).toBe(8);
    expect(offsetOf(text, 99)).toBe(text.length);
    expect(offsetOf(text, 0)).toBe(0);
    expect(offsetOf('', 5, 5)).toBe(0);
  });

  it('positionOf is the inverse, clamped', () => {
    expect(positionOf(text, 0)).toEqual({ line: 1, col: 1 });
    expect(positionOf(text, 3)).toEqual({ line: 2, col: 1 });
    expect(positionOf(text, 6)).toEqual({ line: 3, col: 3 });
    expect(positionOf(text, 999)).toEqual({ line: 4, col: 2 });
    for (const [line, col] of [
      [1, 2],
      [3, 4],
      [4, 1],
    ] as const)
      expect(positionOf(text, offsetOf(text, line, col))).toEqual({ line, col });
  });
});

describe('Tab', () => {
  it('inserts two spaces at the caret', () => {
    expect(insertIndent('ab', 1, 1)).toEqual({ text: 'a  b', caret: 3 });
  });
  it('replaces the selection', () => {
    expect(insertIndent('abcd', 1, 3)).toEqual({ text: 'a  d', caret: 3 });
  });
});

describe('names and ids', () => {
  it('uniqueName numbers clashes, ignoring case', () => {
    expect(uniqueName('Untitled script', [])).toBe('Untitled script');
    expect(uniqueName('Untitled script', ['untitled script'])).toBe('Untitled script 2');
    expect(uniqueName('Untitled script', ['Untitled script', 'Untitled script 2'])).toBe(
      'Untitled script 3',
    );
  });

  it('names stay within the server limit', () => {
    const long = 'x'.repeat(MAX_SCRIPT_NAME);
    expect(uniqueName(long, [])).toHaveLength(MAX_SCRIPT_NAME);
    expect(uniqueName(long, [long])).toHaveLength(MAX_SCRIPT_NAME);
    expect(copyName(long, [])).toHaveLength(MAX_SCRIPT_NAME);
  });

  it('copyName', () => {
    expect(copyName('SMA', ['SMA'])).toBe('SMA copy');
    expect(copyName('SMA', ['SMA', 'SMA copy'])).toBe('SMA copy 2');
  });

  it('new ids fit the server pattern', () => {
    expect(newScriptId()).toMatch(/^[A-Za-z0-9_-]{1,36}$/);
    expect(newScriptId()).not.toBe(newScriptId());
  });
});

describe('instancesOfScript', () => {
  it('picks the instances of that script only', () => {
    const inst = (id: string, type: string) => ({ id, type }) as IndicatorState;
    const list = [
      inst('a', 'user:s1'),
      inst('b', 'sma'),
      inst('c', 'user:s2'),
      inst('d', 'user:s1'),
    ];
    expect(instancesOfScript(list, 's1').map((i) => i.id)).toEqual(['a', 'd']);
    expect(instancesOfScript(list, 's3')).toEqual([]);
  });
});

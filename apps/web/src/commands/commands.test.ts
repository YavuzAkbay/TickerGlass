import { describe, expect, it, vi } from 'vitest';
import { useHistory } from './history';
import { commands } from './registry';

describe('command registry', () => {
  it('registers, executes with args, respects enabled, unregisters', () => {
    const run = vi.fn();
    let enabled = true;
    const off = commands.register({ id: 't.cmd', title: 'Test', run, enabled: () => enabled });
    commands.execute('t.cmd', 42);
    expect(run).toHaveBeenCalledWith(42);
    enabled = false;
    commands.execute('t.cmd');
    expect(run).toHaveBeenCalledTimes(1);
    off();
    expect(commands.get('t.cmd')).toBeUndefined();
  });
});

describe('undo history', () => {
  it('undoes and redoes in order, and new actions clear redo', () => {
    const log: string[] = [];
    const h = useHistory.getState();
    h.clear();
    h.push({ label: 'a', undo: () => log.push('undo a'), redo: () => log.push('redo a') });
    h.push({ label: 'b', undo: () => log.push('undo b'), redo: () => log.push('redo b') });
    useHistory.getState().undo();
    useHistory.getState().undo();
    useHistory.getState().redo();
    expect(log).toEqual(['undo b', 'undo a', 'redo a']);
    useHistory.getState().push({ label: 'c', undo: () => {}, redo: () => {} });
    expect(useHistory.getState().future).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SOUND_NAMES } from './prefs';
import { playSound, SOUNDS, type AudioLike } from './sound';

function fakeCtx(state = 'running') {
  const starts: number[] = [];
  const ctx: AudioLike = {
    currentTime: 1,
    state,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: () => ({
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: (t) => void starts.push(t),
      stop: vi.fn(),
    }),
    createGain: () => ({
      gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
  };
  return { ctx, starts };
}

describe('playSound', () => {
  it('schedules every note of each sound', () => {
    for (const name of SOUND_NAMES) {
      const { ctx, starts } = fakeCtx();
      expect(playSound(name, 0.5, ctx)).toBe(true);
      expect(starts).toHaveLength(SOUNDS[name].length);
    }
  });
  it('does nothing when muted or without WebAudio', () => {
    const { ctx, starts } = fakeCtx();
    expect(playSound('beep', 0, ctx)).toBe(false);
    expect(starts).toHaveLength(0);
    expect(playSound('beep', 1, null)).toBe(false);
  });
  it('resumes a suspended context', () => {
    const { ctx } = fakeCtx('suspended');
    playSound('ding', 1, ctx);
    expect(ctx.resume).toHaveBeenCalled();
  });
});

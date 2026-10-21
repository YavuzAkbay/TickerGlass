/** Alert sounds generated with WebAudio (no bundled assets, docs/alerts.md §5.6). */
import type { SoundName } from './prefs';

interface Note {
  /** Hz */
  freq: number;
  /** Start offset, s */
  at: number;
  /** Length, s */
  dur: number;
  type: OscillatorType;
}

export const SOUNDS: Record<SoundName, Note[]> = {
  beep: [{ freq: 880, at: 0, dur: 0.18, type: 'sine' }],
  chime: [
    { freq: 784, at: 0, dur: 0.25, type: 'sine' },
    { freq: 1175, at: 0.15, dur: 0.4, type: 'sine' },
  ],
  ding: [{ freq: 1568, at: 0, dur: 0.6, type: 'triangle' }],
  alarm: [
    { freq: 988, at: 0, dur: 0.15, type: 'square' },
    { freq: 740, at: 0.2, dur: 0.15, type: 'square' },
    { freq: 988, at: 0.4, dur: 0.15, type: 'square' },
    { freq: 740, at: 0.6, dur: 0.15, type: 'square' },
  ],
};

/** The minimal AudioContext surface used here (so tests can fake it). */
export interface AudioLike {
  currentTime: number;
  state: string;
  destination: unknown;
  resume?: () => Promise<void>;
  createOscillator: () => {
    type: string;
    frequency: { value: number };
    connect: (n: unknown) => void;
    start: (t: number) => void;
    stop: (t: number) => void;
  };
  createGain: () => {
    gain: {
      value: number;
      setValueAtTime: (v: number, t: number) => void;
      exponentialRampToValueAtTime: (v: number, t: number) => void;
    };
    connect: (n: unknown) => void;
  };
}

let shared: AudioLike | null = null;

function defaultContext(): AudioLike | null {
  if (shared) return shared;
  const w = globalThis as {
    AudioContext?: new () => AudioLike;
    webkitAudioContext?: new () => AudioLike;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    shared = new Ctor();
  } catch {
    return null;
  }
  return shared;
}

/**
 * Play a sound at `volume` (0..1). Returns false when nothing was played
 * (muted, or no WebAudio / autoplay blocked).
 */
export function playSound(
  name: SoundName,
  volume: number,
  ctx: AudioLike | null = defaultContext(),
): boolean {
  const vol = Math.min(1, Math.max(0, volume));
  if (!ctx || vol <= 0) return false;
  try {
    if (ctx.state === 'suspended') void ctx.resume?.().catch(() => undefined);
    const t0 = ctx.currentTime;
    for (const n of SOUNDS[name]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type;
      osc.frequency.value = n.freq;
      // Short attack, exponential decay: no clicks. Squares are loud, so they get less.
      const peak = Math.max(0.0001, vol * (n.type === 'square' ? 0.2 : 0.5));
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + n.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + n.dur + 0.02);
    }
    return true;
  } catch (err) {
    console.warn('alert sound failed', err);
    return false;
  }
}

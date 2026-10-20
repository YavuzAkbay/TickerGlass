import { describe, expect, it, vi } from 'vitest';
import type { Chart } from '../chart';
import { InteractionController } from './controller';

type KeyListener = (e: unknown) => void;

function setup() {
  const listeners = new Map<string, KeyListener>();
  const root = {
    addEventListener: (type: string, fn: KeyListener) => listeners.set(type, fn),
  };
  const timeScale = { barSpacing: 6, pan: vi.fn(), zoom: vi.fn() };
  const chart = {
    root,
    timeScale,
    paneWidth: 500,
    drawingInput: { key: () => false },
    scrollToRealtime: vi.fn(),
    resetView: vi.fn(),
    viewChanged: vi.fn(),
    viewSettled: vi.fn(),
  };
  const ctl = new InteractionController(chart as unknown as Chart);
  const press = (key: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) => {
    const e = { key, altKey: false, shiftKey: false, ...mods, preventDefault: vi.fn() };
    listeners.get('keydown')!(e);
    return e;
  };
  return { ctl, chart, timeScale, press };
}

describe('InteractionController keyboard', () => {
  it('pans and zooms with plain arrow keys', () => {
    const { timeScale, press } = setup();
    expect(press('ArrowRight').preventDefault).toHaveBeenCalled();
    expect(timeScale.pan).toHaveBeenCalledWith(-6);
    expect(press('ArrowUp').preventDefault).toHaveBeenCalled();
    expect(timeScale.zoom).toHaveBeenCalledTimes(1);
  });

  it('passes Alt+arrow keys through to the app', () => {
    const { timeScale, chart, press } = setup();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      for (const shiftKey of [false, true]) {
        const e = press(key, { altKey: true, shiftKey });
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(timeScale.pan).not.toHaveBeenCalled();
    expect(timeScale.zoom).not.toHaveBeenCalled();
    expect(chart.viewChanged).not.toHaveBeenCalled();
  });

  it('Alt+R resets the view but Shift+Alt+R is left to the app', () => {
    const { chart, press } = setup();
    expect(press('r', { altKey: true }).preventDefault).toHaveBeenCalled();
    expect(chart.resetView).toHaveBeenCalledTimes(1);
    expect(press('R', { altKey: true, shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('r', { altKey: true, shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('r').preventDefault).not.toHaveBeenCalled();
    expect(chart.resetView).toHaveBeenCalledTimes(1);
  });
});

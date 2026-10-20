import type { ChartSession } from '../chart/session';
import { getActiveSession } from '../store/chart';
import { useUiStore } from '../store/ui';
import { resetToCursor } from '../toolbar/tools';
import { replay } from './instance';
import { useReplayStore } from './store';
import { REPLAY_PICK_ID, barAtOrBefore } from './tool';

/**
 * Scissors bar picker: the replay store's 'picking' status arms the pick tool,
 * the picked bar starts (or moves) the replay, and leaving the tool cancels.
 */
export function attachReplay(session: Pick<ChartSession, 'id' | 'chart'>): () => void {
  const { chart } = session;
  const ui = () => useUiStore.getState();
  const armed = () => ui().activeTool === REPLAY_PICK_ID;
  const offs = [
    useReplayStore.subscribe((s, prev) => {
      if (s.status === prev.status) return;
      if (s.status === 'off' && ui().rightPanel === 'replayTrading') ui().set({ rightPanel: null });
      if (s.status === 'picking') ui().set({ activeTool: REPLAY_PICK_ID });
      else if (prev.status === 'picking' && armed()) resetToCursor();
    }),
    useUiStore.subscribe((s) => {
      // Another tool (or Escape) was chosen while waiting for the bar.
      if (useReplayStore.getState().status === 'picking' && s.activeTool !== REPLAY_PICK_ID)
        replay.cancelPick();
    }),
    chart.on('pointPicked', ({ time }) => {
      // The pick tool is armed on the active chart only.
      if (getActiveSession()?.id !== session.id) return;
      if (!armed() || useReplayStore.getState().status !== 'picking') return;
      const bar = barAtOrBefore(chart.store.time, chart.store.length, time);
      if (bar === null) {
        replay.cancelPick();
        return;
      }
      void replay.start(bar);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    // The chart is going away: stop the play loop, drop the feed's replay state and listeners.
    replay.detach();
  };
}

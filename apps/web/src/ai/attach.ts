/** Ask AI on each chart: the range-select tool feeds the panel's selection. */
import { RANGE_TOOL } from '@tickerglass/engine';
import type { ChartSession } from '../chart/session';
import { getActiveSession, useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { dismissToast, toast } from '../ui/Toast';
import { useAiChat } from './store';

/** The "drag across the bars" hint of the last armed range tool. */
let hint: number | null = null;
const dropHint = () => {
  if (hint !== null) dismissToast(hint);
  hint = null;
};

/** Mirror the chart's range selection into the AI store; a new one opens the panel. */
export function attachAi(session: Pick<ChartSession, 'id' | 'chart'>): () => void {
  const { id, chart } = session;
  const offTool = chart.on('toolFinished', ({ type }) => {
    if (type === RANGE_TOOL) dropHint();
  });
  const off = chart.on('rangeSelected', ({ range }) => {
    const ai = useAiChat.getState();
    ai.setSelection(id, range);
    if (!range) return;
    useUiStore.getState().showNav('ai');
    ai.requestFocus();
  });
  return () => {
    off();
    offTool();
    useAiChat.getState().setSelection(id, null);
  };
}

/** Arm the range-select tool on the active chart (drag across bars to ask about them). */
export function startRangeSelect(): boolean {
  const chart = getActiveSession()?.chart;
  if (!chart || !chart.store.length) return false;
  chart.setActiveTool(RANGE_TOOL);
  dropHint();
  hint = toast('Drag across the bars to ask about (Esc cancels)', 'info', 6000);
  return true;
}

/** Drop the selection of chart `chartId` (band and chip). */
export function clearRangeSelect(chartId: string): void {
  useAiChat.getState().setSelection(chartId, null);
  useChartStore.getState().sessions.get(chartId)?.chart.setRangeSelection(null);
}

import { getDrawingTool, type Chart, type DrawingStyle } from '@investopen/engine';
import { useHistory } from '../commands/history';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { toHideMode } from '../toolbar/commands';
import { findSticker, isCursorTool, resetToCursor } from '../toolbar/tools';
import { openContextMenu } from '../ui/ContextMenu';
import { toast } from '../ui/Toast';
import {
  amendGesture,
  foldHistorySince,
  historyMark,
  inLabelledGesture,
  recordGesture,
  removePaneDrawings,
  type Change,
} from './actions';
import { drawingMenuItems, openDrawingSettings, openTextEditor } from './menu';
import { toolName } from './model';
import {
  drawingsFor,
  startDrawingPersistence,
  useDrawingRuntime,
  useDrawingStore,
  useDrawingTemplates,
} from './store';
import { reconcileDrawings, replaceDrawings, type SyncedDrawings } from './sync';

type UiSnapshot = ReturnType<typeof useUiStore.getState>;

/** Left-toolbar hide button in "Hide drawings" / "Hide all" mode. */
const drawingsHidden = (s: UiSnapshot) =>
  s.hideAll && ['drawings', 'all'].includes(toHideMode(s.groupTools.hide));

/** Engine tool for a left-toolbar tool id and the preset style it is armed with. */
export interface EngineTool {
  type: string;
  style?: DrawingStyle;
}

/**
 * Engine tool for a left-toolbar tool id: a registered type, 'eraser', the engine
 * `icon` tool preset with the glyph for emoji-*, sticker-* and icon-* ids, or null (cursors).
 */
export function engineTool(id: string): EngineTool | null {
  if (getDrawingTool(id)) return { type: id };
  if (id === 'eraser') return { type: id };
  const sticker = findSticker(id);
  if (sticker && getDrawingTool('icon')) return { type: 'icon', style: { glyph: sticker.glyph } };
  return null;
}

/**
 * Keep `chart`'s drawings in sync with the drawing store and the left
 * toolbar, turn engine events into undo steps, and persist the store.
 * Attach before the indicators so a pane removal folds both into one step.
 */
export function attachDrawings(chart: Chart, host: HTMLElement): () => void {
  const persistence = startDrawingPersistence(undefined, 300, (m) => toast(m, 'error'));
  const symbol = () => useAppStore.getState().symbol;
  let shownSymbol: string | null = null;
  let dirty = false;
  const synced: SyncedDrawings = new Map();
  // Engine calls below can emit events that change the store (setDrawings
  // aborting an eraser gesture reports its removals), re-entering sync with
  // `wanted` already stale. Nested calls only flag a rerun.
  let syncing = false;
  let again = false;

  const syncOnce = () => {
    const sym = symbol();
    const wanted = drawingsFor(useDrawingStore.getState(), sym);
    if (sym !== shownSymbol) {
      shownSymbol = sym;
      replaceDrawings(chart, wanted, synced);
      return;
    }
    try {
      reconcileDrawings(chart, wanted, synced);
    } catch (err) {
      // An inconsistent engine list: replace it wholesale.
      console.error(err);
      replaceDrawings(chart, wanted, synced);
    }
  };

  const sync = () => {
    if (useDrawingRuntime.getState().dragging) {
      dirty = true;
      return;
    }
    if (syncing) {
      again = true;
      return;
    }
    dirty = false;
    syncing = true;
    try {
      do {
        again = false;
        syncOnce();
      } while (again);
    } finally {
      syncing = false;
    }
  };

  // Tool + preset glyph last armed: stickers share the engine `icon` type.
  let armed: string | null = null;
  const syncTool = () => {
    const ui = useUiStore.getState();
    const want = engineTool(ui.activeTool);
    const key = want ? `${want.type}:${String(want.style?.glyph ?? '')}` : null;
    if (chart.getActiveTool() === (want?.type ?? null) && key === armed) return;
    try {
      chart.setActiveTool(want?.type ?? null, want?.style ? { style: want.style } : undefined);
      armed = key;
    } catch {
      toast('This tool is not available yet');
      resetToCursor();
    }
  };

  const syncOptions = () => {
    const ui = useUiStore.getState();
    const next = {
      stayInDrawingMode: ui.stayInDrawingMode,
      lockAll: ui.lockAll,
      hideAll: drawingsHidden(ui),
    };
    const cur = chart.getDrawingOptions();
    if (
      cur.stayInDrawingMode !== next.stayInDrawingMode ||
      cur.lockAll !== next.lockAll ||
      cur.hideAll !== next.hideAll
    )
      chart.setDrawingOptions(next);
  };

  sync();
  syncTool();
  syncOptions();

  const onPointerUp = (e: PointerEvent) => {
    if (host.contains(e.target as Node))
      useDrawingRuntime.setState({ pointer: { x: e.clientX, y: e.clientY } });
  };
  const onPageHide = () => persistence.flush();
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('beforeunload', onPageHide);

  // Ids whose drag just ended: drawingCreated for them is an Alt+drag clone.
  let dragEnded: Set<string> | null = null;

  const offs = [
    useDrawingStore.subscribe(sync),
    useAppStore.subscribe((s, prev) => {
      if (s.symbol !== prev.symbol) sync();
    }),
    useUiStore.subscribe(() => {
      syncTool();
      syncOptions();
    }),

    chart.on('drawingCreated', ({ drawing }) => {
      const name = toolName(drawing.type);
      const clone = !!dragEnded?.has(drawing.id);
      const label = !clone
        ? `Create ${name}`
        : dragEnded!.size === 1
          ? `Clone ${name}`
          : 'Clone drawings';
      // "Sync new drawings": drawings made with a tool start synced to all symbols
      // (clones and pastes keep the scope of their source). The store records
      // the create with its final scope; the store -> engine sync then updates
      // the engine copy, so persistence (which follows the store) never sees
      // a symbol-scoped intermediate.
      const after =
        !clone &&
        !inLabelledGesture() &&
        drawing.scope === 'symbol' &&
        useUiStore.getState().syncNewDrawings
          ? { ...drawing, scope: 'all' as const }
          : drawing;
      recordGesture(label, [{ before: null, after }]);
    }),
    chart.on('drawingChanged', ({ changes }) =>
      recordGesture(
        changes.length === 1 ? `Move ${toolName(changes[0]!.after.type)}` : 'Move drawings',
        changes as Change[],
      ),
    ),
    chart.on('drawingsRemoved', ({ drawings }) =>
      recordGesture(
        drawings.length === 1 ? `Remove ${toolName(drawings[0]!.type)}` : 'Remove drawings',
        drawings.map((d) => ({ before: d, after: null })),
      ),
    ),
    chart.on('selectionChanged', ({ ids }) => {
      const textEdit = useDrawingRuntime.getState().textEdit;
      useDrawingRuntime.setState({
        selection: ids,
        ...(textEdit && !ids.includes(textEdit.id) ? { textEdit: null } : {}),
      });
    }),
    chart.on('drawingDrag', ({ ids, phase }) => {
      useDrawingRuntime.setState({ dragging: phase === 'start' });
      if (phase === 'end') {
        dragEnded = new Set(ids);
        queueMicrotask(() => (dragEnded = null));
        if (dirty) sync();
      }
    }),
    chart.on('drawingContextMenu', (e) =>
      openContextMenu(e.clientX, e.clientY, drawingMenuItems(chart.getSelection())),
    ),
    chart.on('drawingDoubleClick', (e) => {
      const d = chart.getDrawing(e.id);
      const def = d && getDrawingTool(d.type);
      if (def?.text && (e.part.kind === 'text' || def.group === 'annotation'))
        openTextEditor(e.id, e.clientX, e.clientY, false);
      else openDrawingSettings(e.id);
    }),
    chart.on('toolFinished', ({ type, drawingId, active }) => {
      if (drawingId) {
        // The user's saved default style applies to drawings made with the tool.
        const style = useDrawingTemplates.getState().defaults[type];
        const def = getDrawingTool(type);
        const d = chart.getDrawing(drawingId);
        // A saved icon default must not replace the sticker that was just placed.
        if (style)
          amendGesture(drawingId, {
            style:
              type === 'icon' ? { ...style, glyph: d?.style.glyph ?? style.glyph ?? '' } : style,
          });
        const at = useDrawingRuntime.getState().pointer;
        if (def?.text && def.group === 'annotation' && d && !d.text && at)
          openTextEditor(drawingId, at.x, at.y, true);
      }
      if (!active && !isCursorTool(useUiStore.getState().activeTool)) resetToCursor();
    }),
    chart.on('paneRemoved', ({ paneId }) => {
      // An undo/redo removed the pane: its entry restores everything itself.
      if (useHistory.getState().applying) return;
      // The indicator controller pushes its own step for the pane's studies
      // in this same dispatch; fold it and the drawings into one step.
      const mark = historyMark();
      queueMicrotask(() => {
        removePaneDrawings(paneId);
        foldHistorySince(mark, 'Remove pane');
      });
    }),
  ];

  return () => {
    offs.forEach((off) => off());
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('beforeunload', onPageHide);
    persistence.stop();
    useDrawingRuntime.setState({ selection: [], dragging: false, textEdit: null });
  };
}

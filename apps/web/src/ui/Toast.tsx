import { X } from 'lucide-react';
import { create } from 'zustand';

type Kind = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  kind: Kind;
  actions: ToastAction[];
}

const useToasts = create<{ items: ToastItem[] }>()(() => ({ items: [] }));
let nextId = 1;

/** Show a toast; returns its id (see `dismissToast`). `ms` 0 keeps it until dismissed. */
export function toast(message: string, kind: Kind = 'info', ms = 3500): number {
  return show(message, kind, ms, []);
}

/**
 * A toast with buttons (e.g. "Reload" / "Overwrite"). It stays until a button
 * or the close button is clicked, unless `ms` is given.
 */
export function actionToast(
  message: string,
  actions: ToastAction[],
  kind: Kind = 'info',
  ms = 0,
): number {
  return show(message, kind, ms, actions);
}

function show(message: string, kind: Kind, ms: number, actions: ToastAction[]): number {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...capToasts(s.items), { id, message, kind, actions }] }));
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

/**
 * Room for one more toast: keep the newest 4 plain ones, and every toast with
 * actions (a conflict waiting for "Reload"/"Overwrite" must not be pushed out).
 */
export function capToasts<T extends { actions: unknown[] }>(items: T[], plain = 4): T[] {
  const keep = new Set(items.filter((t) => !t.actions.length).slice(-plain));
  return items.filter((t) => t.actions.length > 0 || keep.has(t));
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="io-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`io-toast io-toast-${t.kind}`} role="status">
          <span>{t.message}</span>
          {t.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="io-btn io-toast-action"
              onClick={() => {
                dismissToast(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            className="io-icon-btn"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

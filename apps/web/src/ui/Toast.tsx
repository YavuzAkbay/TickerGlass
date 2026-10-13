import { X } from 'lucide-react';
import { create } from 'zustand';

type Kind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: Kind;
}

const useToasts = create<{ items: ToastItem[] }>()(() => ({ items: [] }));
let nextId = 1;

export function toast(message: string, kind: Kind = 'info', ms = 3500): void {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items.slice(-4), { id, message, kind }] }));
  setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number): void {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="io-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`io-toast io-toast-${t.kind}`}>
          <span>{t.message}</span>
          <button
            type="button"
            className="io-icon-btn"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

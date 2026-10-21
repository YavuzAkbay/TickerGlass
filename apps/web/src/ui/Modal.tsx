import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  /** Extra header content (right of title). */
  headerExtra?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Align near the top (search dialogs) instead of centre. */
  top?: boolean;
}

/** Open modals, innermost last: only the top one handles Escape. */
const stack: object[] = [];

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const focusableIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

/**
 * Dialog with overlay. Escape or overlay click closes. Draggable by header.
 * Keyboard: focus starts inside (an autofocused field wins), Tab and
 * Shift+Tab cycle within the dialog, and focus returns to the opener on close.
 */
export function Modal({
  title,
  onClose,
  children,
  width = 520,
  headerExtra,
  footer,
  className,
  top,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The element focused when the dialog opened (restored on close).
  const [opener] = useState(() => document.activeElement);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const token = {};
    stack.push(token);
    const key = (e: KeyboardEvent) => {
      if (stack.at(-1) !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const root = ref.current;
      if (e.key !== 'Tab' || !root) return;
      const items = focusableIn(root);
      const first = items[0] ?? root;
      const last = items.at(-1) ?? root;
      const active = document.activeElement;
      if (!root.contains(active) || (e.shiftKey && (active === first || active === root))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [onClose]);

  // Initial focus (unless a field inside already took it) and restore on close.
  useEffect(() => {
    const root = ref.current;
    if (root && !root.contains(document.activeElement))
      (focusableIn(root.querySelector<HTMLElement>('.io-modal-body') ?? root)[0] ?? root).focus({
        preventScroll: true,
      });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [opener]);

  return createPortal(
    <div
      className={`io-modal-overlay${top ? ' io-modal-top' : ''}`}
      data-modal-open
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`io-modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div
          className="io-modal-header"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('button,input')) return;
            drag.current = {
              x: e.clientX,
              y: e.clientY,
              dx: offset.current.x,
              dy: offset.current.y,
            };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || !ref.current) return;
            offset.current = { x: d.dx + e.clientX - d.x, y: d.dy + e.clientY - d.y };
            ref.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div className="io-modal-title" id={titleId}>
            {title}
          </div>
          {headerExtra}
          <button
            type="button"
            className="io-icon-btn"
            aria-label={t('modal.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="io-modal-body">{children}</div>
        {footer ? <div className="io-modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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

/** Dialog with overlay. Escape or overlay click closes. Draggable by header. */
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
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const token = {};
    stack.push(token);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack.at(-1) === token) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [onClose]);

  return createPortal(
    <div
      className={`io-modal-overlay${top ? ' io-modal-top' : ''}`}
      data-modal-open
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`io-modal ${className ?? ''}`} style={{ width }} role="dialog">
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
          <div className="io-modal-title">{title}</div>
          {headerExtra}
          <button type="button" className="io-icon-btn" aria-label="Close" onClick={onClose}>
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

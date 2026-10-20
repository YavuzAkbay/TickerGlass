import { useEffect, useRef, useState } from 'react';
import { commands } from '../commands/registry';
import { intervalLabel, parseTypedInterval } from '../topbar/intervals';
import { Modal } from '../ui/Modal';
import './dialogs.css';

function initialText(arg: unknown): string {
  if (arg && typeof arg === 'object' && 'initial' in arg) {
    const v = (arg as { initial?: unknown }).initial;
    if (typeof v === 'string') return v;
  }
  return '';
}

/** Compact "type an interval" box opened by pressing a digit on the chart. */
export default function IntervalInputDialog({
  onClose,
  arg,
}: {
  onClose: () => void;
  arg?: unknown;
}) {
  const [text, setText] = useState(() => initialText(arg));
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const parsed = parseTypedInterval(text);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const apply = () => {
    if (!parsed) {
      setTried(true);
      return;
    }
    commands.execute('chart.setInterval', parsed);
    onClose();
  };

  return (
    <Modal title="Change interval" onClose={onClose} width={240} className="dlg-interval">
      <form
        className="dlg-interval-body"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <input
          ref={input}
          className="dlg-interval-input"
          value={text}
          aria-label="Interval"
          aria-invalid={!parsed && text.trim() !== ''}
          aria-describedby="dlg-interval-preview"
          spellCheck={false}
          autoComplete="off"
          maxLength={8}
          onChange={(e) => {
            setText(e.target.value);
            setTried(false);
          }}
          onKeyDown={(e) => {
            // Backspacing the box empty dismisses it.
            if (e.key === 'Backspace' && text === '') onClose();
          }}
        />
        <div
          id="dlg-interval-preview"
          className={`dlg-interval-preview${parsed ? '' : ' invalid'}${tried ? ' shake' : ''}`}
          aria-live="polite"
        >
          {parsed
            ? intervalLabel(parsed)
            : text.trim() === ''
              ? 'Type an interval'
              : 'Invalid interval'}
        </div>
        {!parsed ? <div className="dlg-interval-hint">e.g. 5, 45, 2h, 4h, 1D, 1W, 3M</div> : null}
      </form>
    </Modal>
  );
}

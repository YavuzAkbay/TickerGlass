import { getDrawingTool } from '@investopen/engine';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findDrawing, finishTextEdit } from './actions';
import { useDrawingRuntime, type TextEdit } from './store';
import './drawings.css';

/** Inline text editor over the chart (text tools on creation, double-click on text). */
export function DrawingTextEditor() {
  const edit = useDrawingRuntime((s) => s.textEdit);
  if (!edit) return null;
  return <Editor key={edit.id} edit={edit} />;
}

const close = () => useDrawingRuntime.setState({ textEdit: null });

function Editor({ edit }: { edit: TextEdit }) {
  const d = findDrawing(edit.id);
  const def = d ? getDrawingTool(d.type) : undefined;
  const [value, setValue] = useState(d?.text ?? '');
  const done = useRef(false);
  if (!d || !def?.text) return null;
  const multiline = def.text.multiline;

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    close();
    finishTextEdit(d.id, edit.created, save ? value : null);
  };

  const x = Math.max(4, Math.min(edit.x, window.innerWidth - 264));
  const y = Math.max(4, Math.min(edit.y, window.innerHeight - 120));
  const props = {
    className: 'drw-text-editor io-input',
    'aria-label': `${def.name} text`,
    autoFocus: true,
    value,
    placeholder: 'Add text',
    style: { left: x, top: y },
    'data-own-escape': true,
    onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    onBlur: () => finish(true),
    onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
    onKeyDown: (e: {
      key: string;
      shiftKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey) && !e.shiftKey)
        finish(true);
      else return;
      e.preventDefault();
    },
  };
  return createPortal(
    multiline ? <textarea rows={3} {...props} /> : <input {...props} />,
    document.body,
  );
}

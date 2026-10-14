import { useState } from 'react';
import { create } from 'zustand';
import { Modal } from './Modal';

/**
 * Promise-based name prompt and confirmation dialogs. They render above any
 * open dialog (own host), so a dialog can ask for a name without closing.
 */
type Request =
  | {
      kind: 'prompt';
      title: string;
      label: string;
      initial: string;
      okLabel: string;
      resolve: (v: string | null) => void;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      okLabel: string;
      danger: boolean;
      resolve: (v: boolean) => void;
    };

const usePrompt = create<{ request: Request | null }>()(() => ({ request: null }));

function settle(): void {
  usePrompt.setState({ request: null });
}

/** A new request replaces (cancels) the open one. */
function cancelOpen(): void {
  const r = usePrompt.getState().request;
  if (!r) return;
  settle();
  if (r.kind === 'prompt') r.resolve(null);
  else r.resolve(false);
}

/** Ask for a name. Resolves to the trimmed text, or null when cancelled. */
export function promptName(opts: {
  title: string;
  label?: string;
  initial?: string;
  okLabel?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    cancelOpen();
    usePrompt.setState({
      request: {
        kind: 'prompt',
        title: opts.title,
        label: opts.label ?? 'Name',
        initial: opts.initial ?? '',
        okLabel: opts.okLabel ?? 'Save',
        resolve,
      },
    });
  });
}

/** Ask for confirmation. Resolves to true on Ok. */
export function confirmDialog(opts: {
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    cancelOpen();
    usePrompt.setState({
      request: {
        kind: 'confirm',
        title: opts.title,
        message: opts.message,
        okLabel: opts.okLabel ?? 'Ok',
        danger: !!opts.danger,
        resolve,
      },
    });
  });
}

export function PromptHost() {
  const request = usePrompt((s) => s.request);
  if (!request) return null;
  return request.kind === 'prompt' ? (
    <PromptDialog key={request.title} request={request} />
  ) : (
    <ConfirmDialog request={request} />
  );
}

function PromptDialog({ request }: { request: Extract<Request, { kind: 'prompt' }> }) {
  const [value, setValue] = useState(request.initial);
  const name = value.trim();
  const cancel = () => {
    settle();
    request.resolve(null);
  };
  const ok = () => {
    if (!name) return;
    settle();
    request.resolve(name);
  };
  return (
    <Modal
      title={request.title}
      onClose={cancel}
      width={380}
      className="io-prompt"
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="io-btn io-btn-primary" disabled={!name} onClick={ok}>
            {request.okLabel}
          </button>
        </>
      }
    >
      <input
        className="io-input io-prompt-input"
        aria-label={request.label}
        placeholder={request.label}
        autoFocus
        value={value}
        maxLength={200}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') ok();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
    </Modal>
  );
}

function ConfirmDialog({ request }: { request: Extract<Request, { kind: 'confirm' }> }) {
  const cancel = () => {
    settle();
    request.resolve(false);
  };
  const ok = () => {
    settle();
    request.resolve(true);
  };
  return (
    <Modal
      title={request.title}
      onClose={cancel}
      width={420}
      className="io-prompt"
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`io-btn ${request.danger ? 'io-btn-danger' : 'io-btn-primary'}`}
            autoFocus
            onClick={ok}
          >
            {request.okLabel}
          </button>
        </>
      }
    >
      <p className="io-prompt-message">{request.message}</p>
    </Modal>
  );
}

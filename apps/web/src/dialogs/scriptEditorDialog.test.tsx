import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The dialog renders through <Modal>, a portal host the server renderer skips.
vi.mock('../ui/Modal', () => ({
  Modal: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import ScriptEditorDialog, { draftAfterSave, type Draft } from './ScriptEditorDialog';

const draft = (id: string, isNew = false): Draft => ({ id, isNew, name: id });

describe('draftAfterSave', () => {
  it('marks the draft saved while the same script is still open', () => {
    expect(draftAfterSave(draft('a', true), 'a', 'Saved A')).toEqual({
      id: 'a',
      isNew: false,
      name: 'Saved A',
    });
  });

  it('does nothing when another script was opened during the save', () => {
    // Save of A in flight, the user switched to B: B must stay B.
    expect(draftAfterSave(draft('b'), 'a', 'Saved A')).toBeNull();
  });
});

describe('ScriptEditorDialog', () => {
  it('renders with no scripts (new-script draft)', () => {
    const html = renderToStaticMarkup(<ScriptEditorDialog onClose={() => undefined} />);
    expect(html).toContain('New script');
  });
});

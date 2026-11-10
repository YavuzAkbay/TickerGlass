import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useSectionOpen, type SectionId } from './prefs';
import './symbolInfo.css';

interface Props {
  id: SectionId;
  title: string;
  testId: string;
  /** Right of the title, outside the toggle button. */
  actions?: ReactNode;
  /** Rendered (and so fetching) only while the section is open. */
  children: ReactNode;
}

/** A collapsible block of the detail pane; the open state is remembered per section. */
export function Section({ id, title, testId, actions, children }: Props) {
  const t = useT();
  const [open, toggle] = useSectionOpen(id);
  const bodyId = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="si-section" data-testid={testId} data-open={open}>
      <div className="si-head">
        <button
          type="button"
          className="si-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          title={t(open ? 'si.collapse' : 'si.expand', { section: title })}
          onClick={toggle}
        >
          <Chevron size={13} aria-hidden="true" />
          <span>{title}</span>
        </button>
        {actions ? <div className="si-head-actions">{actions}</div> : null}
      </div>
      <div id={bodyId} className="si-body" hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}

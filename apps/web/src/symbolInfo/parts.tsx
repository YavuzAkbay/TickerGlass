import { useT } from '../i18n';

/** Placeholder rows while a section waits for its data. */
export function Skeleton({ lines = 2 }: { lines?: number }) {
  const t = useT();
  return (
    <div className="si-skel-block" aria-busy="true" aria-label={t('si.loading')}>
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} className="si-skel" style={{ width: `${92 - ((i * 19) % 44)}%` }} />
      ))}
    </div>
  );
}

/** A failed section: what went wrong and a way to ask again. */
export function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="si-error" role="alert">
      <span>{message}</span>
      <button type="button" className="si-retry" onClick={onRetry}>
        {t('si.retry')}
      </button>
    </div>
  );
}

export function Empty({ children }: { children: string }) {
  return <div className="si-empty">{children}</div>;
}

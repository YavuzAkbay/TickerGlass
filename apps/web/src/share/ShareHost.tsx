/* eslint-disable react-hooks/static-components -- `.get()` in render follows lazy-retry resets (as App does for its screens). */
import { Suspense } from 'react';
import { t } from '../i18n';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { retryableLazy } from '../ui/lazyRetry';
import { actionToast } from '../ui/Toast';
import { closeShare, useShareUi } from './open';

const ShareDialog = retryableLazy(() => import('./ShareDialog'));
const ImportFromLinkDialog = retryableLazy(() => import('./ImportFromLinkDialog'));

/** Renders the open share / import dialog (one at a time); the dialogs load on first use. */
export function ShareHost() {
  const request = useShareUi((s) => s.request);
  if (!request) return null;
  const Share = ShareDialog.get();
  const Import = ImportFromLinkDialog.get();
  return (
    <ErrorBoundary
      fallback={() => null}
      onError={(error) => {
        closeShare();
        // A failed chunk import stays failed in React.lazy: start over on retry.
        ShareDialog.reset();
        ImportFromLinkDialog.reset();
        actionToast(t('share.openFailed', { error: error.message }), [], 'error', 10_000);
      }}
    >
      <Suspense fallback={null}>
        {request.kind === 'share' ? (
          <Share payload={request.payload} onClose={closeShare} />
        ) : (
          <Import request={request} onClose={closeShare} />
        )}
      </Suspense>
    </ErrorBoundary>
  );
}

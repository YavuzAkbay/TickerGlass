import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { canClaimLegacyCache, fetchAuthState } from './api/auth';
import { guardCache } from './auth/cacheGuard';
import { ErrorBoundary } from './ui/ErrorBoundary';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/geist-mono';
import './theme/tokens.css';

/**
 * Many stores read their localStorage copy while their module loads (zustand `persist`
 * hydrates synchronously on creation), so the cache guard has to run before `./App` and
 * everything below it is imported: hence the dynamic import. Only the auth client and the
 * guard (no stores) are loaded statically.
 */
async function boot(): Promise<void> {
  try {
    const auth = await fetchAuthState();
    guardCache(auth.user?.id, canClaimLegacyCache(auth));
  } catch {
    // Server unreachable: keep the cache as is (the offline copy is the point); an
    // account switch is caught by the next load that can reach the server.
  }
  const { App } = await import('./App');
  render(App);
}

function render(App: ComponentType): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary
        fallback={(error) => (
          <div className="app-crash" role="alert">
            <h1>Something went wrong</h1>
            <p>{error.message}</p>
            <p>Your layout and drawings are kept in this browser and on the server.</p>
            <button
              type="button"
              className="io-btn io-btn-primary"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          </div>
        )}
      >
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

boot().catch((err: unknown) => console.error('TickerGlass failed to start', err));

// PWA installability (docs/self-hosting.md): the shell worker registers in
// production only; the app works unchanged without it.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Best-effort: installability fails silently (e.g. no HTTPS), nothing breaks.
    });
  });
}

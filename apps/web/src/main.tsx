import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import '@fontsource-variable/inter';
import './theme/tokens.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <div className="app-crash" role="alert">
          <h1>Something went wrong</h1>
          <p>{error.message}</p>
          <p>Your layout and drawings are kept in this browser and on the server.</p>
          <button type="button" className="io-btn io-btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

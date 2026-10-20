// User-script sandbox worker entry (docs/indicators.md §5a), one per
// script instance. Served with a restrictive response CSP (vite.config.ts
// sandboxCsp(), docker/nginx.conf) and locked down in JS before any user code.
// Must bundle into one self-contained file (vite.config.ts build guards), and
// must not pull in the built-in indicators (only `@investopen/indicators/core`).
import { probeLineOffset } from '@investopen/indicators/core';
import { lockdown } from './lockdown';
import { SandboxCore } from './sandboxCore';

// Lockdown first: nothing below (or in user code) sees fetch, postMessage, timers, ...
// Messages are only dispatched after this module has finished evaluating.
const post = lockdown(self, (data) => core.handle(data));
const core = new SandboxCore(post, probeLineOffset(), {
  // `window.sandboxProbe` (ChartView.tsx): dev and e2e builds only, folded to false in production.
  probes: import.meta.env.DEV || import.meta.env.VITE_E2E === '1',
});

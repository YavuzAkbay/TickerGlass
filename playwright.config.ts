import { defineConfig } from '@playwright/test';

// `E2E_PORT` moves the dev server when the default port is taken by another app.
const port = Number(process.env.E2E_PORT) || 5173;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { baseURL: origin, viewport: { width: 1400, height: 800 } },
  webServer: {
    command: `pnpm --filter @tickerglass/web dev --host 127.0.0.1 --port ${port}`,
    url: origin,
    reuseExistingServer: true,
  },
});

// Alert evaluation service. Phase 10 adds alert loading and evaluation;
// for now it only verifies it can reach the data API.

const apiUrl = process.env.API_URL ?? 'http://localhost:8000';
const intervalMs = Number(process.env.ALERTS_POLL_MS ?? 30_000);

async function checkApi(): Promise<void> {
  try {
    const res = await fetch(`${apiUrl}/api/health`);
    console.log(`[alerts] api ${res.ok ? 'ok' : `status ${res.status}`}`);
  } catch (err) {
    console.warn(`[alerts] api unreachable: ${(err as Error).message}`);
  }
}

console.log(`[alerts] starting, api=${apiUrl}`);
void checkApi();
const timer = setInterval(checkApi, intervalMs);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}

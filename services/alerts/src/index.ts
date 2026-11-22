// Alert evaluation service entry point (docs/alerts.md §3).
import { ExpressionFeed, HttpDataFeed, ResamplingFeed } from '@tickerglass/engine/node';
import { ApiClient } from './api';
import { systemClock } from './clock';
import { ConfigError, loadConfig } from './config';
import { ControlSocket } from './control';
import { createLogger, errText } from './log';
import { createService } from './service';
import { childEntry } from './scripts/childBundle';
import { ScriptHost } from './scripts/host';
import { feedHeaders, tokenWebSocket } from './ws-auth';

const SHUTDOWN_MS = 5000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[alerts] invalid configuration: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger(config.logLevel);
  // Alert evaluation reads the same bars the charts show: ask the API to serve it like a visible
  // chart (ahead of background refreshes) so a provider switch reloads the alerts promptly.
  const WebSocketImpl = tokenWebSocket(config.token);
  const http = new HttpDataFeed({
    baseUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    ...(WebSocketImpl ? { WebSocketImpl } : {}),
    headers: feedHeaders(config.token),
  });
  const resampling = new ResamplingFeed(http);
  const feed = new ExpressionFeed(resampling);
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.token });
  const control = new ControlSocket(config.wsUrl, log, WebSocketImpl);
  // The script isolates run in a child process: a script that makes V8 abort ends the child,
  // not the service. `isolated-vm` is a native addon: without a binary for this platform only
  // alerts on user scripts are lost, the rest of the service runs.
  let scripts: ScriptHost;
  try {
    scripts = await ScriptHost.createIsolated({
      process: { entry: childEntry, processMb: config.scriptProcessMb },
      memoryMb: config.scriptMemoryMb,
      loadMs: config.scriptLoadMs,
      tickMs: config.scriptTickMs,
      cpuPct: config.scriptCpuPct,
      cpuTotalPct: config.scriptCpuTotalPct,
      clock: systemClock,
      log,
    });
  } catch (err) {
    log.error('user scripts are disabled: the script runtime could not be loaded', {
      error: errText(err),
    });
    scripts = ScriptHost.disabled(
      'user scripts are unavailable: the script runtime could not be loaded',
      systemClock,
      log,
    );
  }
  const service = createService({
    api,
    control,
    feed,
    clock: systemClock,
    config,
    log,
    live: http,
    scripts,
    disposeFeed: () => http.dispose(),
    clearSymbolCache: () => {
      http.clearSymbolCache();
      resampling.clearSymbolCache();
      feed.clearSymbolCache();
    },
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), SHUTDOWN_MS);
    force.unref();
    void service.stop().then(
      () => {
        scripts.dispose();
        process.exit(0);
      },
      (err: unknown) => {
        log.error('shutdown failed', { error: errText(err) });
        process.exit(1);
      },
    );
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

  await service.start();
}

main().catch((err: unknown) => {
  process.stderr.write(`[alerts] fatal: ${errText(err)}\n`);
  process.exit(1);
});

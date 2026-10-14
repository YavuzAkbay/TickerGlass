// Alert evaluation service entry point (docs/alerts.md §3).
import { ExpressionFeed, HttpDataFeed, ResamplingFeed } from '@investopen/engine/node';
import { ApiClient } from './api';
import { systemClock } from './clock';
import { ConfigError, loadConfig } from './config';
import { ControlSocket } from './control';
import { createLogger, errText } from './log';
import { createService } from './service';

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
  const http = new HttpDataFeed({ baseUrl: config.apiUrl, wsUrl: config.wsUrl });
  const feed = new ExpressionFeed(new ResamplingFeed(http));
  const api = new ApiClient({ baseUrl: config.apiUrl, token: config.token });
  const control = new ControlSocket(config.wsUrl, log);
  const service = createService({
    api,
    control,
    feed,
    clock: systemClock,
    config,
    log,
    live: http,
    disposeFeed: () => http.dispose(),
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), SHUTDOWN_MS);
    force.unref();
    void service.stop().then(
      () => process.exit(0),
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

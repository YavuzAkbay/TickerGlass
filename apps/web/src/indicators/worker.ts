// Indicator worker entry (Vite module worker, one per chart).
// Registers the built-in indicators (workerCore only imports the core).
import '@investopen/indicators';
import type { ToWorker } from './protocol';
import { WorkerCore } from './workerCore';

const core = new WorkerCore((msg, transfer) => self.postMessage(msg, { transfer }));

// handle() never throws; failures arrive as `error` / `resync` messages.
self.addEventListener('message', (e: MessageEvent<ToWorker>) => core.handle(e.data));

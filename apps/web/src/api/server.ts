/** Server maintenance endpoints (Settings → Server, docs/self-hosting.md). */

import { requestJson } from './client';

export interface ServerStatus {
  version: string;
  uptimeSeconds: number | null;
  provider: {
    id: string | null;
    name: string | null;
    configured: boolean;
    cacheSource: string;
  };
  alertsService: {
    online: boolean;
    version?: string;
    startedAt?: string;
    lastError?: string | null;
  };
  database: { kind: string; sizeBytes: number | null };
  counts: Record<string, number>;
  auth: { enabled: boolean };
}

export function fetchServerStatus(): Promise<ServerStatus> {
  return requestJson('GET', '/server/status');
}

/** Wipe cached market data (bars DB rows + in-memory caches); user data is untouched. */
export function clearMarketCache(): Promise<{ cleared: boolean }> {
  return requestJson('POST', '/server/cache/clear');
}

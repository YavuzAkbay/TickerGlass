/** Server maintenance endpoints (Settings → Server, docs/self-hosting.md). */

import { requestJson } from './client';

export interface ServerStatus {
  version: string;
  /** Admin fields (here to `counts`) are omitted for non-admin users. */
  uptimeSeconds?: number | null;
  provider: {
    id: string | null;
    name: string | null;
    configured: boolean;
    cacheSource: string;
  };
  alertsService?: {
    online: boolean;
    version?: string;
    startedAt?: string;
    lastError?: string | null;
  };
  database?: { kind: string; sizeBytes: number | null };
  counts?: Record<string, number>;
  /** Admin; absent on older APIs. */
  backup?: {
    enabled: boolean;
    lastStatus: 'running' | 'ok' | 'partial' | 'failed' | null;
    lastAt: string | null;
    pending: unknown;
  };
  auth: { enabled: boolean; /** Absent on older APIs (password only). */ methods?: string[] };
}

export function fetchServerStatus(): Promise<ServerStatus> {
  return requestJson('GET', '/server/status');
}

/** Wipe cached market data (bars DB rows + in-memory caches); user data is untouched. */
export function clearMarketCache(): Promise<{ cleared: boolean }> {
  return requestJson('POST', '/server/cache/clear');
}

/**
 * Messages between the service (parent) and the script child process (`child.ts`). Node IPC
 * with `serialization: 'advanced'`: structured clones, `Float64Array` included. The parent
 * treats everything the child sends as untrusted (`parseFromChild`), as it does what the
 * isolates inside return (`validate.ts`).
 */

export type ToChild =
  | { t: 'create'; rid: number; memoryMb: number; loadMs: number }
  | { t: 'call'; rid: number; iso: number; name: string; args: unknown[]; timeoutMs: number }
  | { t: 'dispose'; iso: number }
  | { t: 'ping' };

export type FromChild =
  | { t: 'ready' }
  | { t: 'fatal'; message: string }
  /** `isolates`: heap in use plus external memory (bytes) of the isolates that answered in time. */
  | { t: 'pong'; rss: number; isolates: { iso: number; bytes: number }[] }
  | { t: 'created'; rid: number; iso: number }
  /** `raw` is the isolate's envelope: validated by the host, not here. */
  | { t: 'result'; rid: number; raw: unknown; cpuMs: number }
  | { t: 'err'; rid: number; message: string; dead: boolean };

const MAX_TEXT = 1000;
const MAX_ISOLATES = 4096;
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown): string | null =>
  typeof v === 'string' ? (v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v) : null;

/** The message as a `FromChild`, or null when it is not one (shape, types, sizes). */
export function parseFromChild(m: unknown): FromChild | null {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o['t']) {
    case 'ready':
      return { t: 'ready' };
    case 'fatal': {
      const message = text(o['message']);
      return message === null ? null : { t: 'fatal', message };
    }
    case 'pong': {
      const rss = o['rss'];
      const list = o['isolates'];
      if (typeof rss !== 'number' || !Number.isFinite(rss) || rss < 0) return null;
      if (!Array.isArray(list) || list.length > MAX_ISOLATES) return null;
      const isolates: { iso: number; bytes: number }[] = [];
      for (const item of list as unknown[]) {
        if (typeof item !== 'object' || item === null) return null;
        const { iso, bytes } = item as Record<string, unknown>;
        if (!isId(iso) || typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)
          return null;
        isolates.push({ iso, bytes });
      }
      return { t: 'pong', rss, isolates };
    }
    case 'created': {
      const { rid, iso } = o;
      return isId(rid) && isId(iso) ? { t: 'created', rid, iso } : null;
    }
    case 'result': {
      const { rid, cpuMs } = o;
      if (!isId(rid) || typeof cpuMs !== 'number' || !Number.isFinite(cpuMs)) return null;
      return { t: 'result', rid, raw: o['raw'], cpuMs: Math.max(0, cpuMs) };
    }
    case 'err': {
      const { rid, dead } = o;
      const message = text(o['message']);
      if (!isId(rid) || message === null || typeof dead !== 'boolean') return null;
      return { t: 'err', rid, message, dead };
    }
    default:
      return null;
  }
}

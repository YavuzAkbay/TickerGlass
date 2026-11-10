/**
 * Which engine the screener page uses, and how the snapshot banner reads the status.
 * Pure; `ScreenerPage` and the banner only wire it in.
 */
import type { StatusResponse } from './types';

export type ScreenerMode = 'server' | 'client';

/**
 * Server mode needs a supported provider and at least one finished snapshot run. The server
 * reports `asOf` only for a finished run; the first run in flight (`first_run` and `running`)
 * keeps the page on the client engine even if a status ever carried an `asOf`, so it never
 * flips to a half-built server snapshot.
 */
export function screenerMode(status: StatusResponse | null): ScreenerMode {
  if (!status || !status.supported || !status.asOf) return 'client';
  if (status.running && status.reason === 'first_run') return 'client';
  return 'server';
}

export type BannerKind = 'ready' | 'first_run' | 'disabled' | 'provider_unsupported';

export function bannerKind(status: StatusResponse): BannerKind {
  if (screenerMode(status) === 'server') return 'ready';
  if (status.reason === 'disabled' || (!status.enabled && status.reason !== 'provider_unsupported'))
    return 'disabled';
  if (status.reason === 'provider_unsupported') return 'provider_unsupported';
  return 'first_run';
}

export type AgeKey = 'si.agoNow' | 'si.agoMin' | 'si.agoHour' | 'si.agoDay';

/** Age of an ISO timestamp relative to `now` (ms) as an i18n key + count; null when unparsable. */
export function ageOf(iso: string | null, now: number): { key: AgeKey; n: number } | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return { key: 'si.agoNow', n: 0 };
  if (s < 3600) return { key: 'si.agoMin', n: Math.round(s / 60) };
  if (s < 86400) return { key: 'si.agoHour', n: Math.round(s / 3600) };
  return { key: 'si.agoDay', n: Math.round(s / 86400) };
}

export type EtaKey = 'scr.srv.etaSec' | 'scr.srv.etaMin' | 'scr.srv.etaHour';

/** Remaining time of a run as an i18n key + count; null without an estimate. */
export function etaOf(etaS: number | null | undefined): { key: EtaKey; n: number } | null {
  if (typeof etaS !== 'number' || !Number.isFinite(etaS) || etaS < 0) return null;
  if (etaS < 90) return { key: 'scr.srv.etaSec', n: Math.max(1, Math.round(etaS)) };
  if (etaS < 5400) return { key: 'scr.srv.etaMin', n: Math.round(etaS / 60) };
  return { key: 'scr.srv.etaHour', n: Math.round(etaS / 3600) };
}

/** Status poll interval: fast while a run is going, slow otherwise. */
export const POLL_RUNNING_MS = 10_000;
export const POLL_IDLE_MS = 60_000;
export const pollInterval = (status: StatusResponse | null): number =>
  status?.running ? POLL_RUNNING_MS : POLL_IDLE_MS;

/**
 * Opt-in update check (Settings → Server): fetches the latest GitHub release and
 * compares it to the running version. Runs only when the user asks — the app
 * never phones home on its own.
 */

const RELEASES_URL = 'https://api.github.com/repos/yavuzakbay/TickerGlass/releases/latest';

export type UpdateCheckError = 'network' | 'rate-limited' | 'no-releases' | 'unknown';

export interface UpdateCheck {
  /** Running version (TICKERGLASS_VERSION stamp or the VERSION file), without a "v". */
  current: string;
  /** Latest published release version, or null when the check failed. */
  latest: string | null;
  updateAvailable: boolean;
  /** Release page on GitHub, when the check succeeded. */
  releaseUrl: string | null;
  error: UpdateCheckError | null;
}

/** Strip a leading "v" so tags (`v0.2.0`) and stamps (`0.2.0`) compare equal. */
function normalize(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/** -1 when a < b, 0 when equal, 1 when a > b. Non-numeric parts compare lexically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    const ka = Number.isFinite(na) && sa !== '' ? na : sa;
    const kb = Number.isFinite(nb) && sb !== '' ? nb : sb;
    if (ka < kb) return -1;
    if (ka > kb) return 1;
  }
  return 0;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
}

/** Check GitHub for a newer release. Never throws: failures land in `error`. */
export async function checkForUpdate(current = __APP_VERSION__): Promise<UpdateCheck> {
  const base: UpdateCheck = {
    current: normalize(current),
    latest: null,
    updateAvailable: false,
    releaseUrl: null,
    error: null,
  };
  let res: Response;
  try {
    res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      // GitHub releases endpoints do not need credentials; no cookies are sent
      // cross-origin by default (same-site cookie policy).
      credentials: 'omit',
    });
  } catch {
    return { ...base, error: 'network' };
  }
  if (res.status === 403 || res.status === 429) return { ...base, error: 'rate-limited' };
  if (res.status === 404) return { ...base, error: 'no-releases' };
  if (!res.ok) return { ...base, error: 'unknown' };
  let release: GithubRelease;
  try {
    release = (await res.json()) as GithubRelease;
  } catch {
    return { ...base, error: 'unknown' };
  }
  if (typeof release.tag_name !== 'string')
    return { ...base, error: 'unknown' };
  const latest = normalize(release.tag_name);
  return {
    ...base,
    latest,
    updateAvailable: compareVersions(base.current, latest) < 0,
    releaseUrl: typeof release.html_url === 'string' ? release.html_url : null,
  };
}

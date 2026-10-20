/** UI tool id of the scissors bar picker (armed while replay waits for the start bar). */
export const REPLAY_PICK_ID = 'replay-pick';

// Lucide "scissors" (24x24), white halo under a dark stroke so it shows on both themes.
const SCISSORS =
  '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/>' +
  '<circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  `<g stroke="#ffffff" stroke-width="4.5">${SCISSORS}</g>` +
  `<g stroke="#131722" stroke-width="2">${SCISSORS}</g></svg>`;

/** CSS cursor for the scissors: the cut is at the pointer, the icon sits on it. */
export const SCISSORS_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(SVG)}") 12 12, crosshair`;

/** Newest bar time at or before `time`, or null when `time` precedes the series. */
export function barAtOrBefore(
  times: ArrayLike<number>,
  length: number,
  time: number,
): number | null {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : times[lo - 1]!;
}

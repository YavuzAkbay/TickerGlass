import type { ClosedLot, Ledger } from './ledger';

/** Closed FIFO lots that came from one opening transaction (the journal entry's linked trade). */
export function closedLotsForTx(ledger: Ledger, openTxId: string): ClosedLot[] {
  return ledger.closedLots.filter((l) => l.openTxId === openTxId);
}

/**
 * R multiple of a journal entry. A finite manual override wins; otherwise, with a stop and closed
 * lots, `R = sum(pnl) / sum(qty * |openPrice - stop / splitFactor|)`; otherwise null.
 * The stop is quoted in entry-time terms, so it is divided by each lot's `splitFactor` to compare
 * it with the split-adjusted `openPrice`.
 */
export function rMultiple(
  stop: number | null,
  override: number | null,
  closedLots: ClosedLot[],
): number | null {
  if (override !== null && Number.isFinite(override)) return override;
  if (stop === null || !Number.isFinite(stop) || closedLots.length === 0) return null;
  let pnl = 0;
  let risk = 0;
  for (const l of closedLots) {
    const factor = Number.isFinite(l.splitFactor) && l.splitFactor > 0 ? l.splitFactor : 1;
    pnl += l.pnl;
    risk += l.quantity * Math.abs(l.openPrice - stop / factor);
  }
  return risk > 0 ? pnl / risk : null;
}

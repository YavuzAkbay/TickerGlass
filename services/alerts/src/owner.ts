/**
 * Records of different users never mix: a script or drawing is only visible to an alert of the
 * same owner. A record without an `ownerId` (a server that predates multi-user) only matches
 * another record without one, so a missing field never opens a cross-owner path.
 */
export function sameOwner(a: string | undefined | null, b: string | undefined | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Map key of a record owned by `ownerId` with id `id`. */
export function ownerKey(ownerId: string | undefined | null, id: string): string {
  return `${ownerId ?? ''}\u0000${id}`;
}

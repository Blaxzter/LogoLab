// The /labs/ab cache key for a FROZEN comparison. A stamp lives in test/ab-snapshots/, which
// ENGINE_HASH does not cover, and `pnpm gen:absnapshot <same-name>` rewrites the directory in
// place — so a key built from the stamp NAME survives a re-bless and serves the old stamp's
// panels, verdict and heats. The key carries a hash of the raw manifest text instead: every
// write stamps a fresh `createdAt`, so a re-bless always moves it, and a hand edit does too.

import { fnv1a } from './fnv1a.ts'

/** What the key needs of a stamp: its directory name and its manifest exactly as on disk. */
export interface StampIdentity {
  name: string
  raw: string
}

const stampId = (s: StampIdentity): string => `${s.name}@${fnv1a(s.raw)}`

/** Vs-working-tree (`head` omitted) or pair mode. The version prefixes retire every entry
 *  cached under the old name-only keys. */
export function snapOptionsKey(base: StampIdentity, head?: StampIdentity): string {
  return head ? `pair:v3:${stampId(base)}:${stampId(head)}` : `snap:v7:${stampId(base)}`
}

// Whether the working session is saved, and when; backs the header's Saved chip.
//
// Failures are reported, not swallowed: private mode, a blocked origin or a
// full quota make persistence impossible, and the chip must then say "Not
// saved" instead of claiming the work is safe.
//
// A plain observable, read with `useSyncExternalStore`.

export interface SaveStatus {
  /** A write is queued or in flight. */
  pending: boolean
  /** When a write last landed (epoch ms), or null if nothing has been stored yet. */
  savedAt: number | null
  /**
   * Some store's latest write failed — quota, private mode, a blocked origin —
   * and that same store has not been written successfully since.
   */
  failed: boolean
}

/**
 * Writes armed vs. completed, per slot. A count, not a flag: a slot can be
 * re-armed while its previous write is in flight, and a boolean would report
 * "saved" while the newest value is still only in memory.
 */
const armed = new Map<string, number>()
const done = new Map<string, number>()

/**
 * Stores whose latest write failed. Per key, because a failure is only undone by
 * that same store landing a write: a slider's localStorage write succeeding says
 * nothing about the logo that did not fit in IndexedDB, and a failed slot is not
 * retried until its own value changes.
 */
const failedKeys = new Set<string>()

const listeners = new Set<() => void>()
let snapshot: SaveStatus = { pending: false, savedAt: null, failed: false }

function publish(next: SaveStatus): void {
  // useSyncExternalStore compares by identity, so an unchanged status must
  // keep the same object.
  if (next.pending === snapshot.pending && next.savedAt === snapshot.savedAt && next.failed === snapshot.failed) {
    return
  }
  snapshot = next
  for (const listener of listeners) listener()
}

const anyPending = (): boolean => {
  for (const [key, count] of armed) if (count > (done.get(key) ?? 0)) return true
  return false
}

/** A debounced write has been armed for `key`. Returns its sequence number. */
export function markArmed(key: string): number {
  const next = (armed.get(key) ?? 0) + 1
  armed.set(key, next)
  publish({ ...snapshot, pending: true })
  return next
}

/**
 * A write finished. `upTo` is the sequence number taken when the write started:
 * anything armed since is newer and must keep the status pending.
 */
export function markSettled(key: string, upTo: number, ok: boolean): void {
  done.set(key, Math.max(done.get(key) ?? 0, upTo))
  if (ok) failedKeys.delete(key)
  else failedKeys.add(key)
  publish({
    pending: anyPending(),
    savedAt: ok ? Date.now() : snapshot.savedAt,
    failed: failedKeys.size > 0,
  })
}

/**
 * The store for `key` was deleted, its pending write cancelled. Nothing is owed
 * for it any more — neither the cancelled write nor an earlier failure — but
 * nothing was saved either, so the timestamp stays.
 */
export function markDropped(key: string): void {
  done.set(key, armed.get(key) ?? 0)
  failedKeys.delete(key)
  publish({ ...snapshot, pending: anyPending(), failed: failedKeys.size > 0 })
}

/**
 * The boot read found stored work, written at `at`, so a restored session
 * reports when it was last saved rather than "nothing saved yet".
 */
export function markRestored(at: number): void {
  if (snapshot.savedAt !== null && snapshot.savedAt >= at) return
  publish({ ...snapshot, savedAt: at })
}

/** A synchronous (localStorage) write for `key` landed; there is no pending phase. */
export function markSaved(key: string): void {
  failedKeys.delete(key)
  publish({ ...snapshot, savedAt: Date.now(), failed: failedKeys.size > 0 })
}

/** A synchronous store for `key` threw. */
export function markFailed(key: string): void {
  failedKeys.add(key)
  publish({ ...snapshot, failed: true })
}

/** Back to "nothing has been saved" (Start fresh). */
export function resetSaveStatus(): void {
  armed.clear()
  done.clear()
  failedKeys.clear()
  publish({ pending: false, savedAt: null, failed: false })
}

export function getSaveStatus(): SaveStatus {
  return snapshot
}

export function subscribeSaveStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

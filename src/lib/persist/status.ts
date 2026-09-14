// Whether the working session is actually written down, and when.
//
// The app now promises that a reload costs nothing. A promise like that has to be
// visible, and it has to be *honest* — the two states worth showing are "saved a
// moment ago" and "this browser will not let me save", and the second one is the
// whole reason this module reports failure rather than swallowing it. Private
// mode, a blocked origin and a full quota all make persistence silently
// impossible, and a UI that keeps saying "Saved" through that is worse than one
// that says nothing at all.
//
// Deliberately framework-free, like the rest of `lib/`: a plain observable that a
// component reads with `useSyncExternalStore`.

export interface SaveStatus {
  /** A write is queued or in flight. */
  pending: boolean
  /** When a write last landed (epoch ms), or null if nothing has been stored yet. */
  savedAt: number | null
  /** The last attempt failed — quota, private mode, a blocked origin. */
  failed: boolean
}

/**
 * Writes armed vs. writes completed, per slot. A count rather than a flag
 * because writes are debounced: a slot can be re-armed while its own previous
 * write is still in flight, and collapsing that to a boolean would report "saved"
 * while the newest value is still only in memory.
 */
const armed = new Map<string, number>()
const done = new Map<string, number>()

const listeners = new Set<() => void>()
let snapshot: SaveStatus = { pending: false, savedAt: null, failed: false }

function publish(next: SaveStatus): void {
  // useSyncExternalStore compares by identity, so an unchanged status must
  // return the SAME object or every listener re-renders on every keystroke.
  if (
    next.pending === snapshot.pending &&
    next.savedAt === snapshot.savedAt &&
    next.failed === snapshot.failed
  ) {
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
 * A write finished. `upTo` is the sequence number read when the write STARTED,
 * not now: anything armed while it was in flight is a newer value that has not
 * been stored yet, and must keep the status pending.
 */
export function markSettled(key: string, upTo: number, ok: boolean): void {
  done.set(key, Math.max(done.get(key) ?? 0, upTo))
  publish({
    pending: anyPending(),
    savedAt: ok ? Date.now() : snapshot.savedAt,
    failed: !ok,
  })
}

/**
 * The boot read found stored work, written at `at`.
 *
 * Without this the indicator would read "nothing saved yet" for someone who just
 * reloaded INTO their restored session — technically true of this page load, and
 * exactly backwards as an answer to "is my work safe?". The timestamp comes back
 * with the data rather than being invented here, so the chip says when the work
 * was actually last written, not when the tab happened to open.
 */
export function markRestored(at: number): void {
  if (snapshot.savedAt !== null && snapshot.savedAt >= at) return
  publish({ ...snapshot, savedAt: at })
}

/** A synchronous store (localStorage) landed — no pending phase to report. */
export function markSaved(): void {
  publish({ ...snapshot, savedAt: Date.now(), failed: false })
}

/** A synchronous store threw. */
export function markFailed(): void {
  publish({ ...snapshot, failed: true })
}

/** Back to "nothing has been saved" — the Start fresh path. */
export function resetSaveStatus(): void {
  armed.clear()
  done.clear()
  publish({ pending: false, savedAt: null, failed: false })
}

export function getSaveStatus(): SaveStatus {
  return snapshot
}

export function subscribeSaveStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

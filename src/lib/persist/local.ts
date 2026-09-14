// localStorage side of session persistence: the small, synchronous half.
//
// The split with IndexedDB is about WHEN a value is needed, not just how big it
// is. Appearance, the trace options and the export selection have to be correct
// in the first painted frame — reading them asynchronously would mean rendering
// the defaults and then snapping to the user's settings. localStorage is
// synchronous, so `create()` can seed the store from it directly. Bytes (the
// upload, the traced documents) can't live here at all and are read from IDB
// during the boot gate in main.tsx.
//
// Every key is namespaced `logolab:`; `logolab-theme` predates the namespace and
// is left alone (see src/theme.ts).

import { markFailed, markSaved } from './status'

const PREFIX = 'logolab:'

/**
 * Read a stored object, with `defaults` under it so a key added in a later
 * release doesn't come back `undefined` for someone with an older record. The
 * same shape as the labs' useLabState, which is where the pattern comes from.
 */
export function readLocal<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return { ...defaults }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...defaults }
    return { ...defaults, ...(parsed as Partial<T>) }
  } catch {
    // Private mode, a blocked origin, or markup where JSON was expected.
    return { ...defaults }
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
    // Synchronous, so there is no pending phase to report — but it is still a
    // save, and the chip should say so when all someone changed was a slider.
    markSaved()
  } catch {
    // Quota, private mode, a blocked origin. Persistence is best-effort by
    // contract, but the UI must not go on claiming the work is safe.
    markFailed()
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* ignore */
  }
}

/** Drop every `logolab:` key — the "start fresh" path. Leaves the theme alone. */
export function clearLocal(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

/**
 * Coalesce repeated writes to one key.
 *
 * Every slider in this app fires per pointer move, and a slider drag is the
 * normal way to use it — writing (and JSON-stringifying) the whole slice on each
 * frame would put a synchronous localStorage write on the drag's hot path. The
 * trailing write always carries the final value, so the stored state is the same
 * one the user is looking at when they stop.
 */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: T | null = null
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending) {
      const args = pending
      pending = null
      fn(...args)
    }
  }
  const run = (...args: T) => {
    pending = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, ms)
  }
  run.flush = flush
  return run
}

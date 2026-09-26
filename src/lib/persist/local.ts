// localStorage side of session persistence: settings that must be correct in
// the first painted frame. Being synchronous, stores can seed from it in
// `create()` without flashing defaults. Bytes and documents go to IndexedDB
// (see ./session).
//
// Keys are namespaced `logolab:`; `logolab-theme` (src/theme.ts) is separate.

import { markFailed, markSaved } from './status'

const PREFIX = 'logolab:'

/**
 * Read a stored object merged over `defaults`, so keys missing from an older
 * record come back with their default rather than `undefined`.
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
    // Synchronous, so no pending phase, but still a save to report.
    markSaved()
  } catch {
    // Quota, private mode or a blocked origin. Best effort, but the UI must
    // not keep claiming the work is saved.
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

/** Drop every `logolab:` key (start fresh). Leaves the theme alone. */
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
 * Trailing-edge debounce with a `flush()`, so a slider drag doesn't write on
 * every pointer move. The last call's arguments are always the ones written.
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

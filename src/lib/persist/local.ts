// localStorage side of session persistence: settings that must be correct in
// the first painted frame. Being synchronous, stores can seed from it in
// `create()` without flashing defaults. Bytes and documents go to IndexedDB
// (see ./session).
//
// Keys are namespaced `logolab:`; `logolab-theme` (src/theme.ts) is separate.

import { markFailed, markSaved } from './status.ts'

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

/**
 * Set once the session is being forgotten (Start fresh): from then until the
 * reload, a late write would put back what was just cleared.
 */
let frozen = false

/** Refuse every later write; the page is about to reload into an empty session. */
export function freezeWrites(): void {
  frozen = true
}

/** Whether `freezeWrites` has been called. */
export function writesFrozen(): boolean {
  return frozen
}

export function writeLocal(key: string, value: unknown): void {
  if (frozen) return
  // Status key, namespaced apart from the IndexedDB slot names.
  const statusKey = `ls:${key}`
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
    // Synchronous, so no pending phase, but still a save to report.
    markSaved(statusKey)
  } catch {
    // Quota, private mode or a blocked origin. Best effort, but the UI must
    // not keep claiming the work is saved.
    markFailed(statusKey)
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

interface Pending {
  flush: () => void
  cancel: () => void
}

/**
 * Every debounce holding a value it has not written yet. A page that is closing
 * runs no timers and unmounts no components, so this is the only way the
 * `pagehide` flush can reach a settings write or a component's publish into the
 * working logo — not just the IndexedDB slot writers.
 */
const armedDebounces = new Set<Pending>()

/**
 * Run every armed debounce now. Repeats until none is left, because a flush can
 * arm another (publishing a trace into the logo queues the logo slot's write).
 */
export function flushAllDebounces(): void {
  // Bounded: a debounce that re-arms itself on flush must not hang the page.
  for (let round = 0; round < 8 && armedDebounces.size > 0; round++) {
    for (const d of [...armedDebounces]) {
      // One throwing publish must not cost the page every write after it —
      // the slot writers flushed last included.
      try {
        d.flush()
      } catch {
        /* this one is lost; the rest still land */
      }
    }
  }
}

/** Drop every armed debounce's value unwritten (Start fresh). */
export function cancelAllDebounces(): void {
  for (const d of [...armedDebounces]) d.cancel()
}

/**
 * Trailing-edge debounce with a `flush()`, so a slider drag doesn't write on
 * every pointer move. The last call's arguments are always the ones written.
 * `cancel()` drops a pending write, for a caller that is about to forget the
 * value: flushing it later would bring back what was just cleared.
 */
export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: T | null = null
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    armedDebounces.delete(handle)
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
    armedDebounces.add(handle)
  }
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
    armedDebounces.delete(handle)
  }
  const handle: Pending = { flush, cancel }
  run.flush = flush
  run.cancel = cancel
  return run
}

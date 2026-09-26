// A handled failure (e.g. a rejected trace) asks the user whether to report
// it, as a toast in the bottom stack (components/shell/Toasts) rather than a modal,
// since the app still works and the user is mid-task.
//
// Rules that keep it from becoming noise:
//  - One at a time: a newer failure replaces the current notice, never stacks.
//  - Asked once: a dismissed failure never asks again this session. The inline
//    Report link remains for anyone who changes their mind.
//  - A superseded failure (new trace, new file) clears without counting as a no.

export interface FailureNotice {
  /** Identity of this notice, so a re-raise of the same thing is not "new". */
  id: string
  /** What failed, in the app's own words: `the vectorizer`. */
  what: string
  /** The sentence the user is shown. */
  message: string
  /** The error itself, for the report. */
  error: unknown
}

let current: FailureNotice | null = null
const answeredNo = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Ask about a failure. `message` is what the user reads; keep it the same
 * sentence the panel shows, so the toast confirms rather than contradicts.
 */
export function raiseFailure(what: string, message: string, error: unknown): void {
  const id = `${what}|${message}`
  if (answeredNo.has(id)) return
  // Already showing: don't let a retry loop restart it or re-render subscribers.
  if (current?.id === id) return
  current = { id, what, message, error }
  emit()
}

/** The user said no. This exact failure will not ask again this session. */
export function dismissFailure(): void {
  if (!current) return
  answeredNo.add(current.id)
  current = null
  emit()
}

/**
 * Clear without remembering a "no": the failure was superseded (a re-trace
 * started, a new file was picked), not answered.
 */
export function clearFailure(): void {
  if (!current) return
  current = null
  emit()
}

export function getFailure(): FailureNotice | null {
  return current
}

export function subscribeFailure(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests only. */
export function resetFailureNotices(): void {
  current = null
  answeredNo.clear()
}

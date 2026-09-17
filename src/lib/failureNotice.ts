// "That didn't work. Do you want to tell someone?"
//
// A crash gets a whole screen with the question on it. A handled FAILURE — which
// is the one the tracer actually produces, because it runs in a worker that
// catches its own errors — used to get a red line in a status bar with a small
// Report link beside it, at the bottom of a full-height studio. That is not
// asking. It is leaving a note and hoping.
//
// So a failure raises a notice, and the notice is a question with a button. It
// goes in the app's existing bottom toast stack (components/Toasts) rather than
// a modal: the user is mid-task, the app still works, and a dialog that has to
// be dismissed before you can try a different setting would punish them for a
// failure that was not theirs.
//
// TWO RULES that keep it from becoming noise:
//
//   • One at a time. A newer failure REPLACES the current notice rather than
//     stacking — a retrying trace would otherwise pile up a wall of them.
//   • Asked once. Dismiss a failure and the same failure never asks again this
//     session, because the answer was no and re-asking after every retry is how
//     a helpful prompt turns into something people learn to click away. The
//     inline Report link stays exactly where it was for anyone who changes
//     their mind.

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
  // Identical to what is already on screen: leave it alone, so a retry loop
  // cannot restart the notice (or re-render everything subscribed to it).
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
 * Clear without remembering — for when the thing that failed has been superseded
 * (a re-trace started, a new file was picked) rather than answered.
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

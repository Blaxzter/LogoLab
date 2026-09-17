// What ELSE went wrong, and when.
//
// A report that carries only the error in front of you describes the symptom.
// The cause is often something that failed half a minute earlier and was handled
// politely: a decode that fell back, a worker that died and was restarted, a
// rejected promise nobody awaited. None of that reaches a bug report today — it
// reaches the console, which nobody opens and nobody can paste from a phone.
//
// So: a small ring buffer, in memory only. It is never persisted (a session is
// not a debugging archive, and a crash that survives a reload should be
// reproduced, not remembered) and it is never sent anywhere on its own — it is
// one section of a report the user reads before posting.
//
// Repeats COLLAPSE. A render loop or a retrying worker can produce the same
// error fifty times in a second, and fifty copies of one line would push
// everything that matters out of a 25-entry buffer.

/** One thing that went wrong, possibly several times. */
export interface LoggedError {
  /** When it first happened (epoch ms). */
  at: number
  /** When it last happened. Equal to `at` until it repeats. */
  lastAt: number
  /** Where it came from: `window`, `promise`, `trace`, `upload`, `sheet`… */
  source: string
  message: string
  /** How many times this exact source+message has been seen. */
  count: number
}

/** Enough to cover a session's worth of trouble, few enough to fit in a report. */
const MAX_ENTRIES = 25
/** A bundled error message can carry an entire minified expression. */
const MAX_MESSAGE = 300

let entries: LoggedError[] = []

/**
 * Anything that looks like inline data, gone.
 *
 * An error message can quote the URL it failed on, and in this app that URL is
 * sometimes a `data:` URL holding the user's actual image. The promise the crash
 * screen makes is that a report carries the SHAPE of the art and never the art;
 * this is where that promise would otherwise leak. Object URLs are meaningless
 * outside the tab but they are noise, so they shrink too.
 */
export function redact(text: string): string {
  return text
    .replace(/data:[^\s"'`)\]]{16,}/gi, 'data:…')
    .replace(/blob:[^\s"'`)\]]+/gi, 'blob:…')
}

/** `TypeError: x is not a function`, for anything at all that was thrown. */
function label(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name || 'Error'
    return error.message ? `${name}: ${error.message}` : name
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Record something that went wrong. Call it from every catch that currently
 * turns an error into a friendly string — the friendly string is what the user
 * needs and this is what the maintainer needs, and they are not the same thing.
 */
export function logError(source: string, error: unknown): void {
  const text = redact(label(error))
  const message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
  const now = Date.now()

  const seen = entries.findIndex((e) => e.source === source && e.message === message)
  if (seen >= 0) {
    // Move it to the end as well as counting it: "most recent" is what the
    // report prints last and what a reader looks at first.
    const [existing] = entries.splice(seen, 1)
    existing.count += 1
    existing.lastAt = now
    entries.push(existing)
    return
  }

  entries.push({ at: now, lastAt: now, source, message, count: 1 })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

/** Oldest first. A copy, so a report can never mutate the log it is describing. */
export function recentErrors(): LoggedError[] {
  return entries.map((e) => ({ ...e }))
}

export function clearErrorLog(): void {
  entries = []
}

/**
 * Listen for what never reaches a `catch`: an error that escaped every handler,
 * a promise nobody awaited, and a resource that failed to load.
 *
 * That last one shares the `error` event with the first, and it arrives with no
 * `error` object at all — it is how a failed chunk, a missing WASM binary or a
 * blocked model download shows up, which are three of this app's more confusing
 * failures, so it is worth naming properly rather than logging an empty string.
 *
 * Returns the uninstall function. Called once from main.tsx, before the app
 * renders, so the log covers the boot too.
 */
export function installErrorLog(): () => void {
  const onError = (event: ErrorEvent) => {
    const target = event.target as (HTMLElement & { src?: string; href?: string }) | null
    if (target && target !== (globalThis as unknown as EventTarget) && target.tagName) {
      const url = target.src || target.href || ''
      logError('resource', `Failed to load ${target.tagName.toLowerCase()} ${url}`)
      return
    }
    logError('window', event.error ?? event.message)
  }
  const onRejection = (event: PromiseRejectionEvent) => logError('promise', event.reason)

  // Capture phase: a resource error does not bubble, so a listener on the window
  // only sees it on the way down.
  addEventListener('error', onError, true)
  addEventListener('unhandledrejection', onRejection)
  return () => {
    removeEventListener('error', onError, true)
    removeEventListener('unhandledrejection', onRejection)
  }
}

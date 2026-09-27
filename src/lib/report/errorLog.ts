// A small in-memory ring buffer of recent errors, included in issue reports so
// a report shows what else failed earlier in the session. Never persisted and
// never sent on its own.
//
// Repeats collapse into one counted entry: a retrying worker can raise the same
// error dozens of times and would otherwise flush everything else out.

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

const MAX_ENTRIES = 25
/** A bundled error message can carry an entire minified expression. */
const MAX_MESSAGE = 300

let entries: LoggedError[] = []

/**
 * Strips inline data from text bound for a public issue. Not cosmetic: error
 * messages quote the URL they failed on, which can be a `data:` URL holding the
 * user's logo. Reports must carry the art's shape, never the art. `blob:` URLs
 * are shortened as noise.
 */
export function redact(text: string): string {
  return text.replace(/data:[^\s"'`)\]]{16,}/gi, 'data:…').replace(/blob:[^\s"'`)\]]+/gi, 'blob:…')
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
 * Record an error. Call it from every catch that turns an error into a
 * user-facing message, so the raw error still reaches reports.
 */
export function logError(source: string, error: unknown): void {
  const text = redact(label(error))
  const message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
  const now = Date.now()

  const seen = entries.findIndex((e) => e.source === source && e.message === message)
  if (seen >= 0) {
    // Move it to the end so the log stays ordered by most recent occurrence.
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
 * Log what never reaches a `catch`: uncaught errors, unhandled rejections and
 * failed resource loads. A resource failure arrives as an `error` event with no
 * error object, so it is named from its element instead.
 *
 * Returns the uninstall function. Called from main.tsx before the first render.
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

  // Capture phase: resource errors do not bubble.
  addEventListener('error', onError, true)
  addEventListener('unhandledrejection', onRejection)
  return () => {
    removeEventListener('error', onError, true)
    removeEventListener('unhandledrejection', onRejection)
  }
}

// What the app was working on when it fell over.
//
// The useful half of a tracer bug report is not the stack — it is the twenty
// options and the image shape the stack happened under, and those live inside a
// studio's own state where nothing above it can see them. So a panel PUBLISHES
// a snapshot function here while it is mounted, and a report collects from every
// publisher at once — a crash screen (components/ErrorBoundary), a handled
// failure or a "report a problem" the user opened by hand (components/
// ReportIssue).
//
// A function rather than a value, because a value would have to be re-published
// on every slider move. It is called only on the way to a report.
//
// TIMING — this is the part that is easy to break later. A boundary must collect
// in `getDerivedStateFromError`, which React runs during the RENDER phase, while
// the crashing subtree is still mounted. By the time the fallback is committed
// the children are gone, their effect cleanups have run, and every provider they
// registered has already unregistered itself: collect there and the report is
// empty, which looks exactly like a panel that simply had nothing to say.

/** Returns a plain, JSON-able snapshot. Anything it throws is caught. */
export type ReportContextProvider = () => unknown

const providers = new Map<string, ReportContextProvider>()

/**
 * Publish a snapshot function under `key`. Returns the unregister function, so
 * a `useEffect` can simply return it.
 *
 * Keyed, and last-writer-wins: two studios of the same kind on screen at once
 * (the sheet mounts one per tile) would otherwise pile up, and the newest one is
 * the one the user is looking at.
 */
export function provideReportContext(key: string, provider: ReportContextProvider): () => void {
  providers.set(key, provider)
  return () => {
    // Only if it is still ours: a remount registers the new provider before the
    // old one's cleanup runs, and deleting blindly would drop the live one.
    if (providers.get(key) === provider) providers.delete(key)
  }
}

/**
 * Every provider's snapshot, keyed by publisher.
 *
 * Each call is isolated: a provider that throws (it reads live state, and that
 * state is why we are here) contributes a note saying so rather than taking down
 * the crash screen — a second failure at this point leaves the user with the
 * blank page the boundary exists to prevent.
 */
export function collectReportContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, provider] of providers) {
    try {
      const value = provider()
      if (value !== undefined && value !== null) out[key] = value
    } catch (err) {
      out[key] = `<unavailable: ${err instanceof Error ? err.message : String(err)}>`
    }
  }
  return out
}

/** Drop every provider. Tests only — the app unregisters per unmount. */
export function clearReportContext(): void {
  providers.clear()
}

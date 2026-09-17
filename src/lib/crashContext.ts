// What the app was working on when it fell over.
//
// The useful half of a tracer bug report is not the stack — it is the twenty
// options and the image shape the stack happened under, and those live inside a
// studio's own state where no boundary above it can see them. So a panel
// PUBLISHES a snapshot function here while it is mounted, and the crash screen
// collects from every publisher at once (see components/ErrorBoundary).
//
// A function rather than a value, because a value would have to be re-published
// on every slider move. It is called exactly once, on the way to a crash screen.
//
// TIMING — this is the part that is easy to break later. A boundary must collect
// in `getDerivedStateFromError`, which React runs during the RENDER phase, while
// the crashing subtree is still mounted. By the time the fallback is committed
// the children are gone, their effect cleanups have run, and every provider they
// registered has already unregistered itself: collect there and the report is
// empty, which looks exactly like a panel that simply had nothing to say.

/** Returns a plain, JSON-able snapshot. Anything it throws is caught. */
export type CrashContextProvider = () => unknown

const providers = new Map<string, CrashContextProvider>()

/**
 * Publish a snapshot function under `key`. Returns the unregister function, so
 * a `useEffect` can simply return it.
 *
 * Keyed, and last-writer-wins: two studios of the same kind on screen at once
 * (the sheet mounts one per tile) would otherwise pile up, and the newest one is
 * the one the user is looking at.
 */
export function provideCrashContext(key: string, provider: CrashContextProvider): () => void {
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
export function collectCrashContext(): Record<string, unknown> {
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
export function clearCrashContext(): void {
  providers.clear()
}

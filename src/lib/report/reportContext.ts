// Registry of "what was the app working on" snapshots for issue reports.
// Mounted panels publish a snapshot function (a function, so it is only
// evaluated when a report is built); crash screens, failures and manual reports
// collect from all of them.
//
// Timing: an error boundary must collect in `getDerivedStateFromError`, while
// the crashing subtree is still mounted. By the time the fallback commits, the
// children's cleanups have unregistered their providers and the collection
// would be silently empty.

/** Returns a plain, JSON-able snapshot. Anything it throws is caught. */
export type ReportContextProvider = () => unknown

const providers = new Map<string, ReportContextProvider>()

/**
 * Publish a snapshot function under `key`. Returns the unregister function, so
 * a `useEffect` can simply return it. Last writer wins per key (the sheet
 * mounts several studios of one kind; the newest is the one in view).
 */
export function provideReportContext(key: string, provider: ReportContextProvider): () => void {
  providers.set(key, provider)
  return () => {
    // Only if still ours: a remount registers before the old cleanup runs.
    if (providers.get(key) === provider) providers.delete(key)
  }
}

/**
 * Every provider's snapshot, keyed by publisher. A provider that throws yields
 * a note instead, so building a report can never crash the crash screen.
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

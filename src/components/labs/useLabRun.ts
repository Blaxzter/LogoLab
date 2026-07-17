import { useEffect, useRef, useState } from 'react'
import { labCacheGet, labCacheKey, labCachePut } from './labCache'

/** One finished case: its analysis, or the error that stopped it. */
export type LabResult<C, R> = { case: C; value: R; error?: undefined } | { case: C; value?: undefined; error: string }

/**
 * Opt-in result caching for a run. A case whose key + options were computed before (this
 * session, or a past one via IndexedDB) is served from the store instead of re-traced — see
 * labCache.ts. Omit it and the run behaves exactly as before.
 */
export interface LabCacheConfig<C, R> {
  /** Namespaces the keys per lab (its value shape differs, so shapes must not collide). */
  id: string
  /** Stable identity of the CASE. Return null to skip caching this one (e.g. a session-dropped
   *  image whose object URL dies on reload). */
  key: (c: C) => string | null
  /** Everything OTHER than the case that changes the result — res, gradients, variant, etc.
   *  Serialized into the key so a toggle doesn't return a stale value. */
  optionsKey: string
  /** Shrink the value before it is persisted to IndexedDB (identity otherwise). Read straight
   *  back as R, so it must stay structurally usable — the Workbench drops a redundant ImageData
   *  to its dimensions, the only field a consumer reads after analyze. */
  serialize?: (r: R) => unknown
}

/** Shallow (by-identity) comparison of two deps arrays. */
function sameDeps(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

export interface LabRun<C, R> {
  /** Finished cases, in corpus order — grows as the run proceeds. */
  results: LabResult<C, R>[]
  /** The case being analysed right now, if any. */
  pending: C | null
  running: boolean
  status: string
  /** Feeds the progress bar: how far the run is, and how much of it was served from the cache
   *  (instant) rather than freshly computed. `cached === done` means nothing was recalculated. */
  progress: { done: number; total: number; cached: number }
}

/**
 * Run an expensive per-case analysis (a trace is hundreds of ms to tens of seconds)
 * without freezing the tab.
 *
 * Cases are analysed ONE AT A TIME, with a macrotask yield before each, so React can
 * paint the rows that are already done — the incremental "render the row, then trace,
 * then fill it in" behaviour the vanilla pages had. `await Promise.all(...)` over the
 * corpus would hand the main thread a single multi-second block of synchronous tracing
 * and freeze the app shell around it.
 *
 * Re-running (a control changed, or the route unmounted mid-run) cancels the in-flight
 * loop via a token, so a stale trace can never append to the new run's results.
 */
export function useLabRun<C, R>(
  cases: C[],
  analyze: (c: C) => Promise<R>,
  opts: { label: (c: C) => string; done: (n: number) => string; deps: unknown[]; cache?: LabCacheConfig<C, R> },
): LabRun<C, R> {
  const [results, setResults] = useState<LabResult<C, R>[]>([])
  const [pending, setPending] = useState<C | null>(null)
  const [status, setStatus] = useState('Starting…')
  const [running, setRunning] = useState(true)
  const [cached, setCached] = useState(0)

  // The callbacks are re-created every render; only `deps` should re-trigger a run.
  const latest = useRef({ cases, analyze, opts })
  latest.current = { cases, analyze, opts }

  // Discard the previous run's results SYNCHRONOUSLY the moment `deps` change — one render
  // before the effect below would. A consumer that swaps HOW it renders each result across runs
  // (the Workbench renders results through a lens that changes per run) must never paint a stale
  // result through the new renderer: the old value has different fields, so the new one reads
  // `undefined.filter` and crashes. Resetting during render (a sanctioned React pattern for
  // "adjust state when a key changes") means the switch render already sees an empty list.
  const depsRef = useRef(opts.deps)
  if (!sameDeps(depsRef.current, opts.deps)) {
    depsRef.current = opts.deps
    setResults([])
    setPending(null)
    setRunning(true)
    setStatus('Starting…')
    setCached(0)
  }

  useEffect(() => {
    let cancelled = false
    const { cases: cs, analyze: run, opts: o } = latest.current
    setResults([])
    setRunning(true)
    setCached(0)

    void (async () => {
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i]
        if (cancelled) return
        setPending(c)
        setStatus(`${o.label(c)} … (${i + 1}/${cs.length})`)
        // Yield so the shell + the rows already done actually paint before the next
        // trace seizes the main thread.
        await new Promise((r) => setTimeout(r, 0))
        if (cancelled) return
        // A cached case skips the trace + scoring entirely; only genuinely new work computes.
        const ckey = o.cache?.key(c) ?? null
        const fullKey = o.cache && ckey != null ? labCacheKey(o.cache.id, ckey, o.cache.optionsKey) : null
        try {
          let value = fullKey ? await labCacheGet<R>(fullKey) : undefined
          if (cancelled) return
          if (value === undefined) {
            value = await run(c)
            if (cancelled) return
            if (fullKey) labCachePut(fullKey, value, o.cache!.serialize)
          } else {
            setCached((n) => n + 1) // served from the store — no trace/score ran
          }
          setResults((prev) => [...prev, { case: c, value: value as R }])
        } catch (err) {
          if (cancelled) return
          console.error(o.label(c), err)
          setResults((prev) => [...prev, { case: c, error: String(err) }])
        }
      }
      if (cancelled) return
      setPending(null)
      setRunning(false)
      setStatus(o.done(cs.length))
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, opts.deps)

  return { results, pending, running, status, progress: { done: results.length, total: cases.length, cached } }
}

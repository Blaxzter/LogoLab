import { useEffect, useRef, useState } from 'react'

/** One finished case: its analysis, or the error that stopped it. */
export type LabResult<C, R> = { case: C; value: R; error?: undefined } | { case: C; value?: undefined; error: string }

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
  opts: { label: (c: C) => string; done: (n: number) => string; deps: unknown[] },
): LabRun<C, R> {
  const [results, setResults] = useState<LabResult<C, R>[]>([])
  const [pending, setPending] = useState<C | null>(null)
  const [status, setStatus] = useState('Starting…')
  const [running, setRunning] = useState(true)

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
  }

  useEffect(() => {
    let cancelled = false
    const { cases: cs, analyze: run, opts: o } = latest.current
    setResults([])
    setRunning(true)

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
        try {
          const value = await run(c)
          if (cancelled) return
          setResults((prev) => [...prev, { case: c, value }])
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

  return { results, pending, running, status }
}

// At most one call per animation frame, with the LATEST arguments.
//
// A native colour picker fires `input` on every pointer move — several times a
// frame on a high-rate mouse — and every call re-rendered the whole editor:
// measured at 4 events a frame, a batch took ~33 ms, so the picker trailed the
// pointer. Nothing between frames can be seen anyway, so a live control hands
// its value to this and the document is updated once per frame.

import { useCallback, useEffect, useRef } from 'react'

export function useFrameCoalesced<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const latest = useRef(fn)
  latest.current = fn
  const pending = useRef<{ args: A; raf: number } | null>(null)

  // Unmounting mid-drag still delivers the last value rather than dropping it.
  useEffect(
    () => () => {
      const p = pending.current
      if (!p) return
      cancelAnimationFrame(p.raf)
      pending.current = null
      latest.current(...p.args)
    },
    [],
  )

  return useCallback((...args: A) => {
    if (pending.current) {
      pending.current.args = args
      return
    }
    const raf = requestAnimationFrame(() => {
      const p = pending.current
      pending.current = null
      if (p) latest.current(...p.args)
    })
    pending.current = { args, raf }
  }, [])
}

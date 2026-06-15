import { useCallback, useMemo, useRef } from 'react'
import type { PanZoom } from './usePanZoom'

type Pt = { x: number; y: number }

function metrics(a: Pt, b: Pt) {
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
}

/**
 * Two-finger pinch-zoom + pan for touch, composable into any element's existing
 * pointer handlers. While ≥2 touch pointers are down it drives `pz` — zoom about
 * the pinch midpoint and pan by the midpoint's drift — using the same axis-aligned
 * transform math as the wheel path, so image-coordinate mapping is unchanged.
 *
 * Mouse/pen pointers are ignored entirely, so desktop wheel + drag stay
 * byte-for-byte. The host calls `down/move/up` from its own handlers and uses the
 * boolean return (or `active()`) to suppress its one-finger tool behaviour while a
 * pinch is in progress. `boxFor` returns the transformed clipping-box rect that
 * {@link usePanZoom} expects (defaults to the event's currentTarget rect).
 *
 * The returned handlers are referentially stable (state lives in refs), so callers
 * can safely list them in `useCallback`/`useEffect` deps without churn.
 */
export function usePinchZoom(pz: PanZoom, boxFor?: (e: React.PointerEvent) => DOMRect | null) {
  const pts = useRef(new Map<number, Pt>())
  const prev = useRef<ReturnType<typeof metrics> | null>(null)
  // Keep the latest boxFor without changing handler identity.
  const boxRef = useRef(boxFor)
  boxRef.current = boxFor

  const { zoomAround, panBy } = pz

  const box = (e: React.PointerEvent): DOMRect | null =>
    boxRef.current ? boxRef.current(e) : (e.currentTarget as HTMLElement).getBoundingClientRect()

  /** @returns true once a 2-finger gesture has begun (host should cancel 1-finger work). */
  const down = useCallback((e: React.PointerEvent): boolean => {
    if (e.pointerType !== 'touch') return false
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()]
      prev.current = metrics(a, b)
      return true
    }
    return false
  }, [])

  /** @returns true when the move was consumed by a pinch (host should not pan/paint). */
  const move = useCallback(
    (e: React.PointerEvent): boolean => {
      if (e.pointerType !== 'touch' || !pts.current.has(e.pointerId)) return false
      pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pts.current.size < 2 || !prev.current) return pts.current.size >= 2
      const [a, b] = [...pts.current.values()]
      const m = metrics(a, b)
      const r = box(e)
      if (r && prev.current.dist > 0) {
        zoomAround(m.cx, m.cy, m.dist / prev.current.dist, r)
        panBy(m.cx - prev.current.cx, m.cy - prev.current.cy, r)
      }
      prev.current = m
      return true
    },
    [zoomAround, panBy],
  )

  const up = useCallback((e: React.PointerEvent): void => {
    if (e.pointerType !== 'touch') return
    pts.current.delete(e.pointerId)
    if (pts.current.size < 2) prev.current = null
  }, [])

  const active = useCallback(() => pts.current.size >= 2, [])

  return useMemo(() => ({ down, move, up, active }), [down, move, up, active])
}

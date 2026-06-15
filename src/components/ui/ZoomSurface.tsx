import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PanZoom } from '../../hooks/usePanZoom'
import { usePinchZoom } from '../../hooks/usePinchZoom'

const WHEEL_ZOOM_SPEED = 0.0015

/**
 * A clipping box whose child is pan/zoom-transformed by a shared {@link PanZoom}.
 *
 * Scroll to zoom toward the cursor, drag to pan, double-click to reset. Point two
 * surfaces at the *same* `pz` and they move as one synced split view — zooming or
 * panning over either drives both, because the boxes are the same size and share
 * one transform.
 */
export function ZoomSurface({
  pz,
  primary = false,
  className = '',
  children,
}: {
  pz: PanZoom
  /** Register this surface as the box the +/- buttons zoom around. */
  primary?: boolean
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const panning = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const [grabbing, setGrabbing] = useState(false)
  // Two-finger pinch-zoom + pan for touch (the box is this surface's own rect).
  const pinch = usePinchZoom(pz)

  // Native, non-passive wheel listener — React's onWheel is passive, so it can't
  // preventDefault the page scroll while zooming.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      pz.zoomAround(e.clientX, e.clientY, Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED), el.getBoundingClientRect())
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pz.zoomAround])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A second finger turns the gesture into a pinch — abandon the 1-finger pan.
    if (pinch.down(e)) {
      panning.current = false
      setGrabbing(false)
      return
    }
    if (e.button !== 0 && e.button !== 1) return
    panning.current = true
    last.current = { x: e.clientX, y: e.clientY }
    setGrabbing(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unavailable */
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinch.move(e)) return
    if (!panning.current || !ref.current) return
    pz.panBy(e.clientX - last.current.x, e.clientY - last.current.y, ref.current.getBoundingClientRect())
    last.current = { x: e.clientX, y: e.clientY }
  }

  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    pinch.up(e)
    panning.current = false
    setGrabbing(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
  }

  const cursor = pz.scale > 1 ? (grabbing ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'

  return (
    <div
      ref={(el) => {
        ref.current = el
        if (primary) pz.setViewport(el)
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={pz.reset}
      className={`relative touch-none overflow-hidden ${cursor} ${className}`}
    >
      <div className="absolute inset-0" style={pz.contentStyle}>
        {children}
      </div>
    </div>
  )
}

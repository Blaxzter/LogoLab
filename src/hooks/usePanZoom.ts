import { useCallback, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

export interface ViewTransform {
  scale: number
  /** Translation in screen px, applied before scale, relative to the box top-left. */
  x: number
  y: number
}

export interface PanZoomOptions {
  minScale?: number
  maxScale?: number
  /** Multiplicative step for the +/- buttons. */
  zoomStep?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * Headless pan + zoom controller shared by the Cleanup and Vectorize stages.
 *
 * Model: the transformed content fills its clipping box (`absolute inset-0`) and
 * is scaled about the box's top-left corner (`transform-origin: 0 0`). Because the
 * content base size equals the box size, the translation clamp pins the view dead
 * centre at scale 1 and opens up exactly as far as the overflow as you zoom in.
 *
 * It only ever produces axis-aligned scale + translate, so a consumer can keep
 * mapping pointer → image coordinates straight off `getBoundingClientRect()` — the
 * transform is already baked into that rect.
 */
export function usePanZoom(opts: PanZoomOptions = {}) {
  const minScale = opts.minScale ?? 1
  const maxScale = opts.maxScale ?? 8
  const zoomStep = opts.zoomStep ?? 1.5

  const [transform, setTransform] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 })

  // The clipping box used by the +/- buttons (set via setViewport) and a cache of
  // the last box we saw during a gesture, so buttons work even before registration.
  const viewportRef = useRef<HTMLElement | null>(null)
  const lastBoxRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)

  const clampXY = (scale: number, x: number, y: number, w: number, h: number) => {
    // The content is anchored at the box's top-left (transform-origin: 0 0) and
    // scaled, so it overflows down/right only. Keeping it covering the box means
    // the translation lives in [-(overflow), 0] per axis — NOT symmetric around 0.
    // (At scale 1 this pins to 0; the centred view sits at the range's midpoint.)
    const ox = Math.max(0, w * scale - w)
    const oy = Math.max(0, h * scale - h)
    return { x: clamp(x, -ox, 0), y: clamp(y, -oy, 0) }
  }

  /** Zoom by `factor` keeping the content point under (clientX, clientY) fixed. */
  const zoomAround = useCallback(
    (clientX: number, clientY: number, factor: number, box: DOMRect) => {
      lastBoxRef.current = box
      setTransform((prev) => {
        const scale = clamp(prev.scale * factor, minScale, maxScale)
        const k = scale / prev.scale
        if (k === 1) return prev
        const px = clientX - box.left
        const py = clientY - box.top
        const nx = px - (px - prev.x) * k
        const ny = py - (py - prev.y) * k
        const { x, y } = clampXY(scale, nx, ny, box.width, box.height)
        return { scale, x, y }
      })
    },
    [minScale, maxScale],
  )

  const panBy = useCallback((dx: number, dy: number, box: DOMRect) => {
    lastBoxRef.current = box
    setTransform((prev) => {
      const { x, y } = clampXY(prev.scale, prev.x + dx, prev.y + dy, box.width, box.height)
      return { ...prev, x, y }
    })
  }, [])

  const reset = useCallback(() => setTransform({ scale: 1, x: 0, y: 0 }), [])

  const boxRect = (): DOMRect | null => {
    if (viewportRef.current) return viewportRef.current.getBoundingClientRect()
    return lastBoxRef.current as DOMRect | null
  }

  const zoomIn = useCallback(() => {
    const box = boxRect()
    if (box) zoomAround(box.left + box.width / 2, box.top + box.height / 2, zoomStep, box)
  }, [zoomAround, zoomStep])

  const zoomOut = useCallback(() => {
    const box = boxRect()
    if (box) zoomAround(box.left + box.width / 2, box.top + box.height / 2, 1 / zoomStep, box)
  }, [zoomAround, zoomStep])

  /** Callback ref: register the clipping box the buttons zoom around. */
  const setViewport = useCallback((el: HTMLElement | null) => {
    viewportRef.current = el
  }, [])

  const contentStyle = {
    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
    transformOrigin: '0 0',
    // Live zoom, exposed as a CSS variable so overlays inside the scaled content can
    // counter-scale to a CONSTANT screen size. `scale()` above magnifies every stroke,
    // and `vector-effect: non-scaling-stroke` only cancels the SVG's own CTM, not this
    // ancestor transform — so the labs' node wireframe divides its width by this var
    // (`stroke-width: calc(N / var(--pz-scale))`) to stay the same size at any zoom.
    '--pz-scale': transform.scale,
  } as CSSProperties

  return {
    transform,
    scale: transform.scale,
    scalePct: Math.round(transform.scale * 100),
    atDefault: transform.scale === 1 && transform.x === 0 && transform.y === 0,
    canZoomIn: transform.scale < maxScale - 1e-3,
    canZoomOut: transform.scale > minScale + 1e-3,
    contentStyle,
    zoomAround,
    panBy,
    zoomIn,
    zoomOut,
    reset,
    setViewport,
    minScale,
    maxScale,
  }
}

export type PanZoom = ReturnType<typeof usePanZoom>

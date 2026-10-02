// The infinite board's camera, behind the same interface as `usePanZoom`, so
// ZoomSurface (wheel, drag, pinch), the zoom buttons and the stage drive it
// without knowing which one they have.
//
// The camera is concrete from the first measured frame on: it is fitted once,
// and from then on only the user moves it. A camera derived from the artboard
// would jump every time a commit grew the artboard — the opposite of a board
// that stays put while you draw on it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PanZoom } from '../../../hooks/usePanZoom'
import type { Box } from '../../../lib/editor/transform'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  cameraView,
  fitCamera,
  fitPpu,
  panCamera,
  zoomCamera,
  type Camera,
} from '../../../lib/editor/camera'

const ZOOM_STEP = 1.4
const CONTENT_STYLE = { '--pz-scale': 1 } as CSSProperties

export function useBoardCamera(viewBox: readonly number[], active: boolean) {
  const [cam, setCam] = useState<Camera | null>(null)
  const [pane, setPane] = useState({ w: 0, h: 0 })
  const elRef = useRef<HTMLElement | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)

  const [vx, vy, vw, vh] = viewBox
  const art = useMemo<Box>(() => ({ x: vx, y: vy, w: vw, h: vh }), [vx, vy, vw, vh])
  const artRef = useRef(art)
  artRef.current = art

  // ZoomSurface hands the box over on every render; observe it once.
  const setViewport = useCallback((el: HTMLElement | null) => {
    if (el === elRef.current) return
    roRef.current?.disconnect()
    elRef.current = el
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setPane({ w: r.width, h: r.height })
    })
    ro.observe(el)
    roRef.current = ro
  }, [])
  useEffect(() => () => roRef.current?.disconnect(), [])

  // Fit once, on the first frame with a measured pane; forget on leaving Grow
  // so switching back in starts fitted again.
  useEffect(() => {
    if (!active) setCam(null)
    else if (pane.w > 0 && pane.h > 0) setCam((c) => c ?? fitCamera(artRef.current, pane.w, pane.h))
  }, [active, pane.w, pane.h])

  const fit = pane.w > 0 ? fitPpu(art, pane.w, pane.h) : 1
  const limits = useRef({ min: 0, max: Infinity })
  limits.current = { min: fit * MIN_ZOOM, max: fit * MAX_ZOOM }

  const zoomAround = useCallback((clientX: number, clientY: number, factor: number, box: DOMRect) => {
    const { min, max } = limits.current
    setCam((c) =>
      c ? zoomCamera(c, clientX - box.left, clientY - box.top, box.width, box.height, factor, min, max) : c,
    )
  }, [])

  const panBy = useCallback((dx: number, dy: number) => {
    setCam((c) => (c ? panCamera(c, dx, dy) : c))
  }, [])

  const zoomCentre = useCallback(
    (factor: number) => {
      const el = elRef.current
      if (el) {
        const box = el.getBoundingClientRect()
        zoomAround(box.left + box.width / 2, box.top + box.height / 2, factor, box)
      }
    },
    [zoomAround],
  )
  const zoomIn = useCallback(() => zoomCentre(ZOOM_STEP), [zoomCentre])
  const zoomOut = useCallback(() => zoomCentre(1 / ZOOM_STEP), [zoomCentre])

  /** Fit the drawing — the board's "reset" is "show me everything". */
  const reset = useCallback(() => {
    if (pane.w > 0 && pane.h > 0) setCam(fitCamera(artRef.current, pane.w, pane.h))
  }, [pane.w, pane.h])

  const scale = cam ? cam.ppu / fit : 1
  const fitted = pane.w > 0 ? fitCamera(art, pane.w, pane.h) : null
  const atDefault =
    !cam ||
    !fitted ||
    (Math.abs(cam.ppu - fitted.ppu) < 1e-6 * fitted.ppu &&
      Math.abs(cam.cx - fitted.cx) * cam.ppu < 0.5 &&
      Math.abs(cam.cy - fitted.cy) * cam.ppu < 0.5)

  const pz: PanZoom = {
    transform: { scale: 1, x: 0, y: 0 },
    scale,
    scalePct: Math.round(scale * 100),
    atDefault,
    canZoomIn: scale < MAX_ZOOM - 1e-3,
    canZoomOut: scale > MIN_ZOOM + 1e-3,
    contentStyle: CONTENT_STYLE,
    zoomAround,
    panBy,
    zoomIn,
    zoomOut,
    reset,
    setViewport,
    minScale: MIN_ZOOM,
    maxScale: MAX_ZOOM,
  }

  /** The stage's viewBox, in document units; null until the pane is measured. */
  const view = cam && pane.w > 0 ? cameraView(cam, pane.w, pane.h) : null
  return { pz, view }
}

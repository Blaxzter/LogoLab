// Fit-to-container sizing hook for the vectorize canvas. Kept out of
// EditorCanvas.tsx so that file exports only components (Fast Refresh).

import { useEffect, useRef, useState } from 'react'

/**
 * Fit an aspect ratio into the observed size of a container ("contain"),
 * returning explicit pixel dimensions for the fitted box. ResizeObserver-based
 * so it tracks layout (untransformed) size — the pan/zoom CSS transform scales
 * the box visually without re-measuring.
 */
export function useFitBox(aspectW: number, aspectH: number) {
  const parentRef = useRef<HTMLDivElement | null>(null)
  const [avail, setAvail] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setAvail({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const ratio = aspectW > 0 && aspectH > 0 ? aspectW / aspectH : 1
  let width = avail.w
  let height = width / ratio
  if (height > avail.h) {
    height = avail.h
    width = height * ratio
  }
  return { parentRef, width, height }
}

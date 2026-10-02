// The infinite board's camera: where a growing artboard's stage is looking.
//
// A fixed artboard is fitted into its pane and pan/zoom is a clamped CSS
// transform over it (`usePanZoom`), so nothing outside the artboard can be
// reached. A growing artboard has no outside: the stage's SVG always fills the
// pane and its viewBox IS the camera, so you can pan anywhere and draw there.
//
// Pure, so the maths is testable without a DOM.

import type { Box } from './transform.ts'

export interface Camera {
  /** The document point at the centre of the pane. */
  cx: number
  cy: number
  /** Screen pixels per document unit. */
  ppu: number
}

/** Room around the artboard when the camera fits it, as a fraction of the pane. */
export const FIT_MARGIN = 0.12

/** Zoom limits, relative to fitting the artboard. */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 40

/** Screen pixels per unit that fit `box` into a pane, with a margin. */
export function fitPpu(box: Box, paneW: number, paneH: number): number {
  const w = Math.max(1e-6, box.w)
  const h = Math.max(1e-6, box.h)
  const k = 1 - FIT_MARGIN * 2
  return Math.max(1e-6, Math.min((paneW * k) / w, (paneH * k) / h))
}

/** A camera centred on `box` and fitting it into the pane. */
export function fitCamera(box: Box, paneW: number, paneH: number): Camera {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2, ppu: fitPpu(box, paneW, paneH) }
}

/** What the camera shows, in document units — the stage SVG's viewBox. */
export function cameraView(cam: Camera, paneW: number, paneH: number): Box {
  const w = paneW / cam.ppu
  const h = paneH / cam.ppu
  return { x: cam.cx - w / 2, y: cam.cy - h / 2, w, h }
}

/** Drag the board by a screen delta: the content follows the pointer. */
export function panCamera(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, cx: cam.cx - dx / cam.ppu, cy: cam.cy - dy / cam.ppu }
}

/**
 * Zoom by `factor` about a pane point (px from the pane's top-left), keeping
 * the document point under it fixed. `ppu` is clamped to [minPpu, maxPpu].
 */
export function zoomCamera(
  cam: Camera,
  px: number,
  py: number,
  paneW: number,
  paneH: number,
  factor: number,
  minPpu: number,
  maxPpu: number,
): Camera {
  const ppu = Math.min(maxPpu, Math.max(minPpu, cam.ppu * factor))
  if (ppu === cam.ppu) return cam
  const ox = px - paneW / 2
  const oy = py - paneH / 2
  // The document point under the pointer, before and after, must coincide.
  const docX = cam.cx + ox / cam.ppu
  const docY = cam.cy + oy / cam.ppu
  return { cx: docX - ox / ppu, cy: docY - oy / ppu, ppu }
}

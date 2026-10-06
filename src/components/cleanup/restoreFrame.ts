// Where the working buffer sits inside the pristine snapshot. Auto-trim crops
// (and pads) the WORKING pixels only — pristine stays the full image the tab
// opened on, because Reset, AI removal and "undo back to the source" all need
// it whole. Anything that reads pristine for a working pixel (the Restore
// brush, the Keep marker, the overlay ghost) has to go through this origin, or
// it reads the wrong place at the wrong row stride: a sheared restore.
//
// Pure (no React, no DOM beyond `ImageData`) so test/cleanup-restore-frame.test.ts
// can reach it.

/** Pristine coordinates of working pixel (0, 0). Negative inside a trim's pad. */
export interface Origin {
  ox: number
  oy: number
}

export const NO_ORIGIN: Origin = { ox: 0, oy: 0 }

/**
 * The origin after `cropPad(working, bounds, pad)`: working pixel (x, y) came
 * from (x - pad + bounds.x, y - pad + bounds.y) of the buffer that was cropped,
 * which itself sat at `origin`.
 */
export function trimmedOrigin(origin: Origin, bounds: { x: number; y: number }, pad: number): Origin {
  return { ox: origin.ox + bounds.x - pad, oy: origin.oy + bounds.y - pad }
}

/**
 * The pristine pixels laid out on the working buffer's grid (`w`×`h` at
 * `origin`), so a restore reads the pixel that was really there. A pad pixel —
 * outside the pristine image — reads as transparent, which is what the trim put
 * there. Returns `pristine` itself when the two grids already coincide.
 */
export function alignedSource(pristine: ImageData, origin: Origin, w: number, h: number): ImageData {
  const { width: pw, height: ph, data } = pristine
  if (origin.ox === 0 && origin.oy === 0 && pw === w && ph === h) return pristine
  const out = new ImageData(w, h)
  const dst = out.data
  // Columns of the working grid that land inside pristine, the same for every row.
  const x0 = Math.max(0, -origin.ox)
  const x1 = Math.min(w, pw - origin.ox)
  if (x1 <= x0) return out
  for (let y = 0; y < h; y++) {
    const sy = y + origin.oy
    if (sy < 0 || sy >= ph) continue
    const from = (sy * pw + x0 + origin.ox) * 4
    dst.set(data.subarray(from, from + (x1 - x0) * 4), (y * w + x0) * 4)
  }
  return out
}

/**
 * The pristine frame in the working buffer's box, as CSS percentages — where an
 * image covering pristine must be drawn so its pixels sit under the matching
 * working pixels (it overflows the box by the trimmed margin).
 */
export function pristineFrame(
  origin: Origin,
  pristine: { w: number; h: number },
  working: { w: number; h: number },
): { left: string; top: string; width: string; height: string } {
  const pct = (n: number) => `${n * 100}%`
  return {
    left: pct(-origin.ox / working.w),
    top: pct(-origin.oy / working.h),
    width: pct(pristine.w / working.w),
    height: pct(pristine.h / working.h),
  }
}

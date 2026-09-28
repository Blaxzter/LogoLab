// What a fresh upload of this image would get: the settings "Reset" restores.
//
// Not the bare defaults: the studio's probes decide per image (one ink ⇒ mono with
// the measured cut, flat art ⇒ gradients off, coloured ink ⇒ recolour on), and a
// reset that skipped them would trace one-ink art as colour. Pure, in a `.ts` so
// test/fresh-settings.test.ts can import it.

import { suggestGradients } from '../../../lib/trace/rampiness.ts'
import { applyInkMode, decideInkMode, type InkColorMode } from '../../../lib/traceInput/ink.ts'
import type { VectorizeOptions } from '../../../types.ts'

/**
 * Above this Rec.709 luma the probed ink is clearly not black, so a mono trace
 * (always #000) is repainted with the ink's colour by default.
 */
export const INK_IS_BLACK_LUMA = 32

export interface FreshSettings {
  opts: VectorizeOptions
  colorMode: InkColorMode
  forceColorOn: boolean
  /** The ink's own colour for the recolour swatch, when the probe found one. */
  forceColor: string | null
}

/**
 * @param base the options a new image starts from (the app defaults, or a host's plan)
 * @param colorMode the Mode a new image starts in
 * @param pixels the probe's raster, or null before it lands (then only `base` applies)
 * @param probeGradients whether the gradients toggle is decided from the pixels;
 *   a host that planned the trace (the icon sheet) has already decided it
 */
export function freshSettings(
  base: VectorizeOptions,
  colorMode: InkColorMode,
  pixels: ImageData | null,
  probeGradients: boolean,
): FreshSettings {
  if (!pixels) return { opts: base, colorMode, forceColorOn: false, forceColor: null }
  const plan = decideInkMode(pixels, base.threshold, { colorMode })
  let opts = applyInkMode(base, plan)
  if (probeGradients) opts = { ...opts, gradients: suggestGradients(pixels) }
  const forceColorOn = plan.recolor != null && plan.probe.inkLuma != null && plan.probe.inkLuma > INK_IS_BLACK_LUMA
  return { opts, colorMode, forceColorOn, forceColor: plan.recolor ?? null }
}

/** Whether two option sets trace the same, ignoring markers (edits to the image, not settings). */
export function sameSettings(a: VectorizeOptions, b: VectorizeOptions): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  keys.delete('markers')
  for (const k of keys) {
    const av = a[k as keyof VectorizeOptions]
    const bv = b[k as keyof VectorizeOptions]
    // Also covers an absent key against an explicit `undefined`.
    if (av === bv) continue
    if (av === undefined || bv === undefined) return false
    if (typeof av !== 'object' || JSON.stringify(av) !== JSON.stringify(bv)) return false
  }
  return true
}

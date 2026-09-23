// The mono cut as a LABEL MAP — what lets one-ink art ride the planar tracer.
//
// Mono used to be its own little pipeline: threshold → binary mask → the crisp
// mask tracer → loop beautify. That fitter could only put anchors on contour
// samples, so a 61° peak whose tip the raster never held came back as a 4px
// chamfer, while the same peak through the planar fitter was recovered to half a
// pixel (docs/vectorization-benchmarks.md §37). Every corner, apex, junction and
// circle rule since July lives in the planar path — and with the ink probe making
// Mono the default for one-ink art, most icons were never reaching it.
//
// So mono is now a SEGMENTATION with two labels, ink and paper, handed to
// `tracePlanar` exactly as a colour segmentation is. One label cannot be carved,
// which is the property that made mono win over the colour path on shaded
// single-ink art in the first place (src/lib/ink.ts); the fitter is the one the
// rest of the tracer is measured on.
//
// Three details are decided here rather than in the tracer:
//
//  • The cut is `cutLuma` (ink.ts): a COVERAGE cut on art over transparency.
//  • Despeckle is the old mono contract — a loop-area floor in px², the turdsize
//    the crisp and potrace tracers took — applied to connected components of BOTH
//    labels (an ink speck becomes paper, a pinhole becomes ink). It is far gentler
//    than the colour path's region floor (4px² against 50px² at the default), and
//    that is deliberate: the dot on an "i" at 499px is 4px².
//  • The source the planar passes read for sub-pixel edges (§15) and apex evidence
//    (§18) is COMPOSITED over the paper the cut assumes. Those passes fit a
//    two-colour model to the raw RGB, and on black-on-transparent art the raw RGB
//    of a transparent pixel is black too — the model degenerates and every chain
//    falls back to the lattice. Composited, the anti-aliasing is a real ramp from
//    ink to paper, the same one an opaque rendering has. Opaque art is unchanged.

import { cutLuma, VISIBLE_ALPHA, type ImageDataLike } from '../ink.ts'

/** Label of the ink in the map `monoLabels` builds. */
export const MONO_INK = 0
/** Label of the paper. */
export const MONO_PAPER = 1

export interface MonoSegmentation {
  /** Row-major, `MONO_INK` or `MONO_PAPER` for every pixel. */
  labels: Int32Array
  /** Mean colour of each label over the composited source (index = label). */
  palette: { r: number; g: number; b: number }[]
  /** The source composited over the paper — opaque RGBA the planar passes can read. */
  image: { data: Uint8ClampedArray; width: number; height: number }
  /** Ink pixels after despeckling. */
  inkPixels: number
}

/**
 * Cut `img` at `threshold` (`invert` puts the light side in ink), drop ink
 * components and pinholes under `minArea` px², and return the two-label map with
 * what the planar tracer wants beside it.
 */
export function monoLabels(img: ImageDataLike, threshold: number, invert: boolean, minArea: number): MonoSegmentation {
  const { width, height, data } = img
  const n = width * height
  const cut = Math.max(0, Math.min(255, Math.round(threshold)))
  const paper = invert ? 0 : 255

  const labels = new Int32Array(n).fill(MONO_PAPER)
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3]
    if (a < VISIBLE_ALPHA) {
      out[p] = out[p + 1] = out[p + 2] = paper
      out[p + 3] = 255
      continue
    }
    if (a === 255) {
      out[p] = data[p]
      out[p + 1] = data[p + 1]
      out[p + 2] = data[p + 2]
    } else {
      const k = a / 255
      out[p] = data[p] * k + paper * (1 - k)
      out[p + 1] = data[p + 1] * k + paper * (1 - k)
      out[p + 2] = data[p + 2] * k + paper * (1 - k)
    }
    out[p + 3] = 255
    const lum = cutLuma(data, p, invert)
    if (invert ? lum > cut : lum < cut) labels[i] = MONO_INK
  }

  if (minArea > 1) {
    flipSmallComponents(labels, width, height, MONO_INK, MONO_PAPER, minArea)
    flipSmallComponents(labels, width, height, MONO_PAPER, MONO_INK, minArea)
  }

  // Label means over the composited image — the two-entry palette the contrast
  // rank (§14) reads. Paper on transparency is the paper colour by construction.
  const sum = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const s = sum[labels[i]]
    s[0] += out[p]
    s[1] += out[p + 1]
    s[2] += out[p + 2]
    s[3]++
  }
  const mean = (s: number[]) => (s[3] > 0 ? { r: s[0] / s[3], g: s[1] / s[3], b: s[2] / s[3] } : { r: paper, g: paper, b: paper })
  return {
    labels,
    palette: [mean(sum[MONO_INK]), mean(sum[MONO_PAPER])],
    image: { data: out, width, height },
    inkPixels: sum[MONO_INK][3],
  }
}

/**
 * Relabel every 4-connected component of `from` smaller than `minArea` px² to
 * `to`. A component that touches the image border is kept: it is the edge of
 * something larger, not a speck.
 */
function flipSmallComponents(labels: Int32Array, width: number, height: number, from: number, to: number, minArea: number): void {
  const n = width * height
  const seen = new Uint8Array(n)
  const stack: number[] = []
  const members: number[] = []
  for (let start = 0; start < n; start++) {
    if (seen[start] || labels[start] !== from) continue
    seen[start] = 1
    stack.length = 0
    members.length = 0
    stack.push(start)
    let border = false
    while (stack.length) {
      const i = stack.pop()!
      members.push(i)
      const x = i % width
      const y = (i - x) / width
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true
      if (x > 0 && !seen[i - 1] && labels[i - 1] === from) { seen[i - 1] = 1; stack.push(i - 1) }
      if (x < width - 1 && !seen[i + 1] && labels[i + 1] === from) { seen[i + 1] = 1; stack.push(i + 1) }
      if (y > 0 && !seen[i - width] && labels[i - width] === from) { seen[i - width] = 1; stack.push(i - width) }
      if (y < height - 1 && !seen[i + width] && labels[i + width] === from) { seen[i + width] = 1; stack.push(i + width) }
    }
    if (!border && members.length < minArea) for (const i of members) labels[i] = to
  }
}

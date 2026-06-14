// Purpose-built demo scenes for the control info-dialog previews.
//
// The bundled example logos are clean vector-style art (no noise, no specks, no
// midtones), so they can't visibly demonstrate Despeckle, Fidelity, Threshold or
// (on the crisp engine) Smoothing. These scenes are tiny synthetic documents,
// rasterized to source pixels the way lineArtCorpus does — each crafted so ONE
// knob's effect is obvious in the before/after. The same source doc is also
// serialized to an SVG thumbnail so the dialog can show exactly what was traced.
//
// Deterministic (seeded PRNG, no Math.random) so regenerating is a no-op diff.

import type { EditableDoc, PathItem } from '../lib/path/types.ts'
import { ellipseSubPaths } from '../lib/path/model.ts'

export type SceneKey = 'smoothing' | 'despeckle' | 'fidelity' | 'threshold' | 'overlaps'

export interface Scene {
  width: number
  height: number
  doc: EditableDoc
}

/** Small LCG — reproducible across builds (Math.random would churn the output). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const INK = '#27303f'

function polygon(id: string, fill: string, pts: [number, number][], extra: Partial<PathItem> = {}): PathItem {
  return {
    kind: 'path',
    id,
    fill,
    fillRule: 'nonzero',
    subPaths: [{ closed: true, nodes: pts.map(([x, y]) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })) }],
    visible: true,
    ...extra,
  }
}

/** Smoothing: a disc with a finely rippled edge. Higher smoothing's pre-blur
 *  rounds the ripples; the curve fitter then needs fewer nodes. (Gentle on the
 *  crisp engine by design — the dramatic lever is the Potrace engine.) */
function smoothingScene(): Scene {
  const W = 256, H = 256, cx = 128, cy = 128
  const rand = rng(7)
  const N = 128
  const pts: [number, number][] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    // Many small, high-frequency ripples (~1–2.5px): fine enough that the crisp
    // pre-blur (0.35→0.9px) visibly rounds more of them as smoothing rises.
    const r = 86 + 2.6 * Math.sin(a * 19) + 1.6 * Math.sin(a * 37 + 1.3) + (rand() - 0.5) * 1.6
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return { width: W, height: H, doc: { viewBox: [0, 0, W, H], items: [polygon('blob', INK, pts)] } }
}

/** Despeckle: a clean shape surrounded by stray specks of two sizes. Higher
 *  despeckle raises the turd-size cutoff, dropping the small specks then the
 *  larger ones — so the path count falls in clear steps. */
function despeckleScene(): Scene {
  const W = 256, H = 256
  const rand = rng(42)
  const items: PathItem[] = [
    { kind: 'path', id: 'core', fill: INK, fillRule: 'nonzero', subPaths: [ellipseSubPaths(128, 128, 58, 58)![0]], visible: true },
  ]
  // Two speck sizes: ~3px (area ~9) drops first, ~6px (area ~36) drops later.
  const specks: { size: number; count: number }[] = [
    { size: 3, count: 26 },
    { size: 6, count: 16 },
  ]
  let k = 0
  for (const { size, count } of specks) {
    for (let i = 0; i < count; i++) {
      // Keep specks out in the margin, clear of the core disc.
      let x = 0, y = 0
      for (let t = 0; t < 12; t++) {
        x = 18 + rand() * (W - 36)
        y = 18 + rand() * (H - 36)
        if (Math.hypot(x - 128, y - 128) > 78) break
      }
      const s = size
      items.push(polygon(`speck-${k++}`, INK, [
        [x, y],
        [x + s, y],
        [x + s, y + s],
        [x, y + s],
      ]))
    }
  }
  return { width: W, height: H, doc: { viewBox: [0, 0, W, H], items } }
}

/** Fidelity: a slightly-wobbly near-circle and a near-straight bent bar. Higher
 *  fidelity lets the beautify pass snap them to a perfect ellipse / line. */
function fidelityScene(): Scene {
  const W = 256, H = 256
  const rand = rng(99)
  const cx = 128, cy = 96, R = 64
  const N = 22
  const ring: [number, number][] = []
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const r = R + (rand() - 0.5) * 5 // ±2.5px wobble — snaps under high fidelity
    ring.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  // A near-horizontal bar with a small kink at its midpoint.
  const bar: [number, number][] = [
    [40, 196],
    [128, 193],
    [216, 196],
    [216, 206],
    [128, 203],
    [40, 206],
  ]
  return {
    width: W,
    height: H,
    doc: { viewBox: [0, 0, W, H], items: [polygon('ring', INK, ring), polygon('bar', INK, bar)] },
  }
}

/** Threshold (mono): a left→right grayscale ramp built from stepped-opacity
 *  black strips over white. A higher cutoff keeps more of the lighter side, so
 *  the solid region grows visibly wider. */
function thresholdScene(): Scene {
  const W = 256, H = 256
  const strips = 64
  const items: PathItem[] = []
  for (let i = 0; i < strips; i++) {
    const x0 = (i / strips) * W
    const x1 = ((i + 1) / strips) * W
    const opacity = i / (strips - 1) // 0 (white) → 1 (black), left → right
    items.push(
      polygon(`strip-${i}`, '#000000', [
        [x0, 0],
        [x1, 0],
        [x1, H],
        [x0, H],
      ], { fillOpacity: opacity }),
    )
  }
  return { width: W, height: H, doc: { viewBox: [0, 0, W, H], items } }
}

/** Region markers: three translucent overlapping circles (like the bloom logo).
 *  With marker seeds on each lobe and overlap, the segmentation keeps every piece
 *  as its own shape instead of fusing the soft overlaps into a neighbour. */
function overlapsScene(): Scene {
  const W = 256, H = 256
  // Same colour, semi-transparent: the lobes read as one blue field and the
  // overlaps as darker bands, so the automatic merge fuses them WITHOUT markers
  // — markers then force each lobe + overlap back into its own shape.
  const circle = (i: number, cx: number, cy: number): PathItem => ({
    kind: 'path',
    id: `c${i}`,
    fill: '#3b82f6',
    fillRule: 'nonzero',
    fillOpacity: 0.55,
    subPaths: [ellipseSubPaths(cx, cy, 60, 60)![0]],
    visible: true,
  })
  return {
    width: W,
    height: H,
    doc: {
      viewBox: [0, 0, W, H],
      items: [circle(0, 128, 96), circle(1, 92, 160), circle(2, 164, 160)],
    },
  }
}

export const SCENES: Record<SceneKey, () => Scene> = {
  smoothing: smoothingScene,
  despeckle: despeckleScene,
  fidelity: fidelityScene,
  threshold: thresholdScene,
  overlaps: overlapsScene,
}

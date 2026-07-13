// The golden corpus + the gate arithmetic, in a form BOTH sides can import.
//
// Why this file exists: `traceGolden.ts` is Node-only (it reads fixtures off disk
// via node:fs and the local PNG decoder), so the browser view could not import the
// corpus from it. Rather than re-declare the case list in the view — where it could
// silently drift from what the regression test actually traces — the pure, portable
// parts live here and traceGolden.ts re-exports them. One definition, two consumers.
//
// Nothing here touches the blessed baseline; it only DESCRIBES the corpus and the
// thresholds so a view can show how close each case sits to failing.

import { DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { EditableDoc } from '../lib/path/types.ts'
import type { VectorizeOptions } from '../types'

/** Any row-major RGBA buffer — a DecodedImage (Node) and an ImageData both satisfy it. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** One regression case: a named image + the trace options to lock in. */
export interface GoldenCase {
  name: string
  path: string
  /** Long-side cap before tracing (mirrors the app); 0 ⇒ native resolution. */
  maxDim: number
  options: VectorizeOptions
  /** Marks a case heavy enough to skip unless INCLUDE_SLOW=1 (perf-sensitive). */
  slow?: boolean
}

/**
 * The validation corpus. Small gradients-ON images (nebula, petals) exercise the
 * Step-3c gradient union-merge — nebula is the purpose-2 guardian (a background the
 * discontinuity map split must reunite into ONE gradient). The flat / gradients-OFF
 * cases (schild, headphones) guard the common flat-art and complex-photo paths. The
 * gradients-ON headphones photo is the perf-sensitive case (Step-3c at scale) and is
 * marked `slow` until the merge is fast enough to run every CI invocation.
 */
export const GOLDEN_CORPUS: GoldenCase[] = [
  { name: 'nebula', path: 'public/examples/nebula.png', maxDim: 0, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: true } },
  { name: 'petals', path: 'public/examples/petals.png', maxDim: 0, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: true } },
  { name: 'schild-flat', path: 'examples/test-files/schild.png', maxDim: 512, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false } },
  { name: 'headphones-flat', path: 'examples/test-files/Headphones.png', maxDim: 1024, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false } },
  { name: 'headphones-grad', path: 'examples/test-files/Headphones.png', maxDim: 512, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: true }, slow: true },
  // Junction-quality guards (gradients OFF — the flat/posterized regime): bloom's
  // translucent-circle crossings are the degree-4 cluster case, aurora's posterized
  // diagonal ramp is the jagged band-boundary case. Fixtures are the example SVGs
  // pre-rasterized to 512px (test/fixtures/) since the node harness has no SVG
  // rasterizer.
  { name: 'bloom-flat', path: 'test/fixtures/bloom-512.png', maxDim: 0, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false } },
  { name: 'aurora-flat', path: 'test/fixtures/aurora-512.png', maxDim: 0, options: { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false } },
]

/** Compact, comparable record for one traced case. */
export interface GoldenRecord {
  name: string
  width: number
  height: number
  gradients: boolean
  paths: number
  nodes: number
  gradientCount: number
  meanDeltaE: number
  p95DeltaE: number
  ssim: number
  seamMax: number
  /** Junction vertices in the shared-edge graph (structural simplicity signal). */
  junctions?: number
  /** Unresolved junction clusters (≥2 vertices within 3px) — should never grow. */
  junctionClusters?: number
  /** Largest span (px) inside any junction cluster. */
  clusterSpanMax?: number
  /** Mean |turn| per px (deg/px) over boundary curves — staircase wobble scores high. */
  jaggedness?: number
  /** Exact canonical-doc fingerprint (precision 6) — the determinism / "did anything
   *  change" signal. */
  hash: string
  /** Node-position fingerprint (coords quantised to 0.1px) — sensitive to real
   *  geometry drift, blind to sub-pixel serialisation noise. */
  geomSig: string
}

/** Box-downscale to a max long-side dimension (mirrors the app's RASTER_MAX_DIM
 *  step so corpus geometry matches what the studio actually traces). */
export function downscale(img: RgbaImage, maxDim: number): RgbaImage {
  const { width: w, height: h, data } = img
  const scale = Math.min(1, maxDim / Math.max(w, h))
  if (scale >= 1) return img
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx0 = Math.floor((x / nw) * w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / nw) * w))
    const sy0 = Math.floor((y / nh) * h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / nh) * h))
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const o = (sy * w + sx) * 4
      r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]; n++
    }
    const o = (y * nw + x) * 4
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
  }
  return { width: nw, height: nh, data: out }
}

/** FNV-1a over a string (matches metrics.hashDoc's mixer). */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Position fingerprint: every node anchor + handle, quantised to 0.1px, hashed in
 * document order. Real node motion changes it; reformatting / precision-only diffs
 * do not. Independent of `hash` so the two catch different drift.
 */
export function geomSignature(doc: EditableDoc): string {
  const q = (v: number): number => Math.round(v * 10)
  const parts: string[] = []
  for (const item of doc.items) {
    if (item.kind !== 'path') continue
    for (const sp of item.subPaths) {
      for (const nd of sp.nodes) {
        parts.push(`${q(nd.x)},${q(nd.y)}`)
        if (nd.hIn) parts.push(`i${q(nd.hIn.x)},${q(nd.hIn.y)}`)
        if (nd.hOut) parts.push(`o${q(nd.hOut.x)},${q(nd.hOut.y)}`)
      }
    }
  }
  return fnv1a(parts.join(';'))
}

// ---------------------------------------------------------------------------
// The gates, as data — so a view can SHOW them
// ---------------------------------------------------------------------------

/**
 * MIRRORS the `TOL` literal in test/trace-regression.test.ts. That file remains the
 * single authority the build actually enforces; this copy exists so the dev view can
 * draw the thresholds. If you ever change the test's TOL, change it here too — or,
 * better, make the test import THIS constant so the two cannot diverge.
 */
export const TOL = {
  meanDeltaE: 0.6, // CIE76 ΔE units the render mean may worsen by
  ssim: 0.012, // SSIM the render may drop by
  seamMax: 2.0, // ΔE the worst smooth-field seam may worsen by
  countRatio: 0.12, // ±12% drift allowed in path / node counts
  jaggedness: 0.15, // relative worsening allowed in boundary turn-per-px
}

/** The extra ADDITIVE slack the jaggedness gate grants on top of the ×1.15 ratio
 *  (cap = golden × 1.15 + 0.2). Easy to miss reading the test, and it dominates the
 *  gate whenever the golden jaggedness is small. */
export const JAGGEDNESS_ABS_SLACK = 0.2

/** One gate, evaluated for one case. */
export interface GateRow {
  key: string
  label: string
  /** Human form of the rule, e.g. "≤ golden + 0.6". */
  rule: string
  /** Current measured value. */
  value: number
  /** The blessed value. */
  golden: number
  /** The value at which the gate FAILS (for a band, the bound the value is nearest). */
  limit: number
  /** Band gates only. */
  lo?: number
  hi?: number
  pass: boolean
  /**
   * Fraction of the allowance still unused: 1 = sitting exactly on the golden (full
   * allowance left), 0 = exactly at the limit, negative = failing. >1 means the case
   * has IMPROVED past its golden.
   */
  headroom: number
  /** Absolute distance to the limit, in the metric's own units. */
  slack: number
  /** True when the gate only constrains ONE direction (the other is free). */
  oneSided: boolean
  /** How many units of allowance the gate grants at all (limit − golden). */
  allowance: number
  digits: number
}

const clampHead = (h: number): number => (Number.isFinite(h) ? h : 1)

/** Evaluate every HARD gate of the regression test for one case. Pure arithmetic —
 *  no assertions, no side effects; it just reports where the value sits. */
export function evaluateGates(g: GoldenRecord, cur: {
  meanDeltaE: number
  ssim: number
  seamMax: number
  paths: number
  nodes: number
  junctionClusters: number
  jaggedness: number
}): GateRow[] {
  const rows: GateRow[] = []

  const upper = (key: string, label: string, rule: string, value: number, golden: number, limit: number, digits: number): void => {
    const allowance = limit - golden
    rows.push({
      key, label, rule, value, golden, limit, pass: value <= limit,
      headroom: clampHead(allowance > 0 ? (limit - value) / allowance : value <= limit ? 1 : -1),
      slack: limit - value, oneSided: true, allowance, digits,
    })
  }

  upper('meanDeltaE', 'mean ΔE', `≤ g + ${TOL.meanDeltaE}`, cur.meanDeltaE, g.meanDeltaE, g.meanDeltaE + TOL.meanDeltaE, 3)

  // SSIM is a FLOOR, not a ceiling — higher is better, so the allowance runs downward.
  const ssimFloor = g.ssim - TOL.ssim
  rows.push({
    key: 'ssim', label: 'SSIM', rule: `≥ g − ${TOL.ssim}`, value: cur.ssim, golden: g.ssim, limit: ssimFloor,
    pass: cur.ssim >= ssimFloor,
    headroom: clampHead((cur.ssim - ssimFloor) / TOL.ssim),
    slack: cur.ssim - ssimFloor, oneSided: true, allowance: TOL.ssim, digits: 4,
  })

  upper('seamMax', 'seam max', `≤ g + ${TOL.seamMax}`, cur.seamMax, g.seamMax, g.seamMax + TOL.seamMax, 2)

  const band = (key: string, label: string, value: number, golden: number): void => {
    const lo = Math.floor(golden * (1 - TOL.countRatio))
    const hi = Math.ceil(golden * (1 + TOL.countRatio))
    const pass = value >= lo && value <= hi
    // Report against whichever bound the value is closer to failing.
    const nearHi = Math.abs(hi - value) <= Math.abs(value - lo)
    const limit = nearHi ? hi : lo
    const allowance = Math.abs(limit - golden)
    rows.push({
      key, label, rule: `within ±${TOL.countRatio * 100}%`, value, golden, limit, lo, hi, pass,
      headroom: clampHead(allowance > 0 ? Math.abs(limit - value) / allowance : pass ? 1 : -1),
      slack: Math.abs(limit - value), oneSided: false, allowance, digits: 0,
    })
  }
  band('paths', 'paths', cur.paths, g.paths)
  band('nodes', 'nodes', cur.nodes, g.nodes)

  // Zero-tolerance: a cluster that appears on art that had none is a real regression.
  const gc = g.junctionClusters ?? 0
  rows.push({
    key: 'junctionClusters', label: 'junction clusters', rule: '≤ g (zero tolerance)',
    value: cur.junctionClusters, golden: gc, limit: gc, pass: cur.junctionClusters <= gc,
    headroom: cur.junctionClusters <= gc ? (gc === 0 ? 1 : (gc - cur.junctionClusters) / gc) : -1,
    slack: gc - cur.junctionClusters, oneSided: true, allowance: 0, digits: 0,
  })

  // NOTE the ADDITIVE +0.2 on top of the ×1.15 — on a case whose golden jaggedness is
  // small (aurora 0.289) the additive term, not the ratio, is what sets the cap.
  const gj = g.jaggedness ?? 0
  const cap = gj * (1 + TOL.jaggedness) + JAGGEDNESS_ABS_SLACK
  upper('jaggedness', 'jaggedness', `≤ g × ${1 + TOL.jaggedness} + ${JAGGEDNESS_ABS_SLACK}`, cur.jaggedness, gj, cap, 3)

  return rows
}

/** Metrics the golden RECORDS but no gate constrains — free to drift arbitrarily. */
export const UNGATED_KEYS = ['p95DeltaE', 'clusterSpanMax', 'gradientCount', 'junctions'] as const

/**
 * Dev-server URL for a case's fixture. Corpus paths are repo-relative; Vite serves
 * `public/` at `/` and everything else in the project root at its own path.
 */
export function caseUrl(c: GoldenCase): string {
  return c.path.startsWith('public/') ? `/${c.path.slice('public/'.length)}` : `/${c.path}`
}

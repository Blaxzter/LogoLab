// Regression / validation harness for the tracing pipeline (the "validation set"
// the user asked for: trace a fixed corpus and compare node counts, positions and
// rendered fidelity against a stored golden, so an algorithm change that REGRESSES
// quality or shifts geometry is caught before it ships).
//
// Two layers, mirroring scoreboard.ts:
//   • tolerance metrics (meanΔE / SSIM / seam / paths / nodes) — the HARD gate the
//     regression test asserts. Tolerant enough that a legitimate improvement passes,
//     tight enough that a real regression fails.
//   • exact fingerprints (`hash` of the canonical doc, `geomSig` of node positions) —
//     RECORDED so a human (and the test log) can see precisely what moved. The test
//     reports a fingerprint change but does not fail on it (intentional changes are
//     expected; rerun `npm run gen:golden` to bless them).
//
// Pure + node-harness friendly (PNG corpus via the local decoder), so it runs under
// `node --test` exactly like harness.test.ts.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { DecodedImage } from './png.ts'
import { loadPng } from './nodeHarness.ts'
import type { EditableDoc } from '../lib/path/types.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import { hashDoc } from './metrics.ts'
import type { VectorizeOptions } from '../types'

/** Box-downscale to a max long-side dimension (mirrors the app's RASTER_MAX_DIM
 *  step so corpus geometry matches what the studio actually traces). */
export function downscale(img: DecodedImage, maxDim: number): DecodedImage {
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

/** Project root, mirroring nodeHarness's resolution (src/devtest → repo root). */
function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * Whether a case's source image is present. The schild / headphones fixtures live in
 * the untracked `examples/test-files/`, so on a fresh checkout they may be absent —
 * the test skips those cases instead of crashing (nebula / petals are always present).
 */
export function caseAvailable(c: GoldenCase): boolean {
  return existsSync(join(projectRoot(), c.path))
}

/** Load + (optionally) downscale a case's source image. */
export function loadCase(c: GoldenCase): DecodedImage {
  const img = loadPng(c.path)
  return c.maxDim > 0 ? downscale(img, c.maxDim) : img
}

/** Trace a case and produce its comparable record. */
export async function recordCase(c: GoldenCase): Promise<GoldenRecord> {
  const img = loadCase(c)
  const src = img as unknown as { width: number; height: number; data: Uint8ClampedArray }
  const doc = await traceImage(img as unknown as ImageData, c.options)
  const s = scoreDoc(src, doc)
  return {
    name: c.name,
    width: img.width,
    height: img.height,
    gradients: c.options.gradients !== false,
    paths: s.paths,
    nodes: s.nodes,
    gradientCount: s.gradients,
    meanDeltaE: round(s.meanDeltaE, 3),
    p95DeltaE: round(s.p95DeltaE, 2),
    ssim: round(s.ssim, 4),
    seamMax: round(s.seamMax, 2),
    junctions: s.junctions,
    junctionClusters: s.junctionClusters,
    clusterSpanMax: round(s.clusterSpanMax, 2),
    jaggedness: round(s.jaggedness, 3),
    hash: hashDoc(doc),
    geomSig: geomSignature(doc),
  }
}

const round = (v: number, d: number): number => (Number.isFinite(v) ? Number(v.toFixed(d)) : v)

/** Path to the stored golden baseline JSON. */
export function goldenPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'golden', 'trace-baseline.json')
}

export function loadGolden(): Record<string, GoldenRecord> {
  return JSON.parse(readFileSync(goldenPath(), 'utf8')) as Record<string, GoldenRecord>
}

/** Write the records, MERGING over any existing baseline so a case skipped this run
 *  (missing fixture) keeps its previously-blessed record rather than being dropped. */
export function saveGolden(records: GoldenRecord[]): void {
  const map: Record<string, GoldenRecord> = existsSync(goldenPath()) ? loadGolden() : {}
  for (const r of records) map[r.name] = r
  writeFileSync(goldenPath(), JSON.stringify(map, null, 2) + '\n')
}

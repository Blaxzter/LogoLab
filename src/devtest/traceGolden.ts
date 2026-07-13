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
import { traceImage } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import { hashDoc } from './metrics.ts'
import { GOLDEN_CORPUS, downscale, geomSignature, type GoldenCase, type GoldenRecord } from './traceCorpus.ts'

// The corpus definition, the box-downscale and the geometry fingerprint are pure and
// live in ./traceCorpus.ts so the browser view (which cannot import node:fs) shares
// the SAME case list and trace options this gate runs on. Re-exported here so the
// regression test's existing imports are unchanged.
export { GOLDEN_CORPUS, downscale, geomSignature }
export type { GoldenCase, GoldenRecord }

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

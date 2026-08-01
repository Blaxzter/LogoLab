// Shared scoreboard runner (plan §5): trace → rasterize → score, plus a
// byte-identical re-run determinism check. Pure and environment-agnostic, so the
// headless `node --test` harness and the browser harness (/labs/eval — EvalLab)
// produce directly comparable numbers from the same code.

import type { EditableDoc } from '../lib/path/types.ts'
import { rasterizeDoc, boundaryMask } from './raster.ts'
import { fidelity, usefulness, topologyMetrics, hashDoc, type FidelityMetrics, type UsefulnessMetrics, type TopologyMetrics } from './metrics.ts'

/** Minimal source-image shape (a real ImageData satisfies it). */
export interface SourceImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export type TraceRun = () => Promise<EditableDoc>

export interface ScoreRow extends FidelityMetrics, UsefulnessMetrics, TopologyMetrics {
  name: string
  engine: string
  width: number
  height: number
  runtimeMs: number
  /** FNV-1a fingerprint of the canonical doc. */
  hash: string
  /** 'pass' when a second identical run produced a byte-identical doc. */
  determinism: 'pass' | 'fail'
}

/**
 * Trace `source` twice with `run`, score the first result against the source,
 * and report whether the two runs were byte-identical. Runtime is the first
 * trace only (the second exists purely for the determinism check).
 */
export async function score(name: string, engine: string, source: SourceImage, run: TraceRun): Promise<ScoreRow> {
  const t0 = performance.now()
  const doc1 = await run()
  const runtimeMs = performance.now() - t0

  const doc2 = await run()
  const hash = hashDoc(doc1)
  const determinism: 'pass' | 'fail' = hash === hashDoc(doc2) ? 'pass' : 'fail'

  return { name, engine, ...scoreDoc(source, doc1), runtimeMs, hash, determinism }
}

/** Score a single already-traced doc against a source image (no re-run). */
export function scoreDoc(
  source: SourceImage,
  doc: EditableDoc,
): FidelityMetrics & UsefulnessMetrics & TopologyMetrics & { width: number; height: number } {
  const { width, height } = source
  const render = rasterizeDoc(doc, width, height)
  const mask = boundaryMask(doc, width, height, 1)
  const fid = fidelity(source.data, render, width, height, mask)
  const use = usefulness(doc)
  const topo = topologyMetrics(doc)
  return { width, height, ...fid, ...use, ...topo }
}

const f = (v: number, d = 3): string => (Number.isFinite(v) ? v.toFixed(d) : String(v))

/** A markdown table of score rows (used by the baseline writer + harness log). */
export function scoreboardMarkdown(rows: ScoreRow[]): string {
  const head =
    '| image | engine | L1 Lab | meanΔE | P95 ΔE | SSIM | seam max | seam P99.5 | paths | nodes | grad | ms | det |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  const body = rows.map(
    (r) =>
      `| ${r.name} | ${r.engine} | ${f(r.l1Lab, 2)} | ${f(r.meanDeltaE, 2)} | ${f(r.p95DeltaE, 1)} | ${f(r.ssim, 4)} | ${f(r.seamMax, 1)} | ${f(r.seamP995, 1)} | ${r.paths} | ${r.nodes} | ${r.gradients} | ${f(r.runtimeMs, 0)} | ${r.determinism} |`,
  )
  return [head, ...body].join('\n')
}

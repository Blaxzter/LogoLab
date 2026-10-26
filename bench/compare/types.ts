// Shared shapes for the vectorizer comparison (bench/compare/run.ts).
//
// A CASE is an authored SVG (the answer sheet) plus what the scorer needs to know about it;
// a TOOL turns the case's raster into an SVG string. Everything a tool returns goes through
// ONE scoring path (score.ts) — LogoLab included, via its serialized string — so no tool is
// measured on an in-memory shortcut the others do not get.

export type CorpusId = 'truth0' | 'fluent2' | 'svgemoji-v0' | 'svgemoji' | 'strokes-oss'

/**
 * What a corpus's answer sheet IS. 'fill': authored filled outlines, scored by the truth
 * gate's outline geometry (score.ts). 'line': authored STROKES, scored as centrelines with
 * widths (bench/centerlineScore.ts) — a different question with different metrics, so a
 * line corpus is never mixed with a fill corpus in a table, a median or a rank.
 */
export type CorpusKind = 'fill' | 'line'

/** The line corpora; every other corpus is 'fill'. A function, not a Record over
 *  CorpusId, so a corpus added elsewhere is a fill corpus without touching this file. */
export const corpusKind = (id: CorpusId): CorpusKind => (id === 'strokes-oss' ? 'line' : 'fill')

export interface CompareCase {
  /** Unique within the run: `<corpus>/<name>`. */
  id: string
  corpus: CorpusId
  name: string
  /** Absolute path to the authored SVG. */
  svgPath: string
  /** Gradient fitting on for LogoLab's gate preset (the truth gate's own per-case flag). */
  gradients: boolean
  /** Tolerance tier for evaluateTruthGates (TIER_TOL). External sets use tier 2 (flat art). */
  tier: 0 | 1 | 2
  inkFamilies?: string[][]
  /** In-sample = LogoLab was developed against it. Never the headline. */
  heldOut: boolean
  license: string
  source: string
  /** The raster's long side when the corpus fixes it (a line corpus scores at the A/B line
   *  lane's resolution, the flat cap), overriding run.ts's --res. Absent: --res. */
  res?: number
}

export interface TraceInput {
  /** The case raster on white, as a PNG file every tool reads. */
  pngPath: string
  image: { width: number; height: number; data: Uint8ClampedArray }
  /** 'mono' when the raster is one ink on white paper (Potrace only runs there). */
  lane: 'colour' | 'mono'
  /** The case's ink (corpus.ts inkOf): on a mono case the one dark flat colour. */
  ink: string
  case: CompareCase
}

export interface TraceResult {
  svg: string
  ms: number
  notes?: string
}

export interface TracerAdapter {
  name: string
  /** Which lanes the tool runs on. A colour case is not given to a mono-only tool. */
  lanes: ('colour' | 'mono')[]
  /** Which corpus kinds the tool runs on; absent = both. A centreline tracer has nothing
   *  to say about a fill corpus (logolab-strokes, autotrace-centerline). */
  kinds?: CorpusKind[]
  /** Null when the tool is unavailable — the reason is printed and the tool skipped. */
  available(): Promise<string | null>
  version(): Promise<string>
  /** Batch tools (StarVector) trace every input in one call so the model loads once. */
  traceBatch?(inputs: TraceInput[], outDir: string): Promise<Map<string, TraceResult | { error: string }>>
  trace?(input: TraceInput): Promise<TraceResult>
}

/** One (tool, case) row. A failure is a row with `status` ≠ 'ok', never a missing row. */
export interface ScoreRow {
  tool: string
  caseId: string
  corpus: CorpusId
  heldOut: boolean
  res: number
  /** Flat art (gradients off): region / corner / circle gates apply. */
  flat: boolean
  lane: 'colour' | 'mono'
  status: 'ok' | 'trace-failed' | 'render-failed'
  error?: string
  /** What the tool said about this trace (StarVector's valid/cleaned/placeholder, logolab-auto's plan). */
  notes?: string
  ms: number | null
  /** Why geometry is n/a for this output (svgGround refusal / no viewBox / …), else null. */
  geomRefusal: string | null
  /** Why the GROUND TRUTH has no geometry (stroked authored art, …), else null. */
  gtRefusal: string | null
  // geometry (tool-agnostic gates)
  samples?: number
  chamfer?: number
  p95?: number
  hausdorff?: number
  missedMean?: number
  spuriousMean?: number
  /** Node density ÷ the artist's, canvas-edge boundary excluded on both sides (score.ts). */
  parsimony?: number
  /** docNodes / gtNodes, raw. */
  nodeRatio?: number
  gtNodes?: number
  docNodes?: number
  docPaths?: number
  gtCorners?: number
  cornersRecovered?: number
  cornersInvented?: number
  tangentBreaks?: number
  circles?: number
  circleSpread?: number
  regionsTrue?: number
  regionsRecovered?: number
  worstInk?: number
  // paint
  meanDeltaE?: number
  p95DeltaE?: number
  ssimLuma?: number
  // size
  bytes?: number
  gzipBytes?: number
  normBytes?: number
  gradientDefs?: number
  // gates (allowances OFF — every tool held to the same absolute limits)
  gatesApplicable?: number
  gatesPassed?: number
  failedGates?: string[]
  // SVG-Bench (joined from py/svgbench_metrics.py)
  sbMse?: number | null
  sbSsim?: number | null
  sbLpips?: number | null
  sbDino?: number | null
  sbTokens?: number | null
  /** StarVector only: tokens the MODEL generated (its own tokenizer, raw text), as opposed to
   *  sbTokens, counted on the post-processed file (cairosvg-repaired for 'cleaned' rows). */
  genTokens?: number
  // centreline (line corpora only — bench/centerlineScore.ts against the authored strokes,
  // via compare/lineDoc.ts; absent on a fill row, and n/a with geomRefusal 'no strokes'
  // when the output has no stroked path). Pixel limits for the gate verdict scale with the
  // raster (centerlineTol); the numbers themselves are raw px at `res`.
  /** Traced centreline → nearest authored centreline, mean px (precision). */
  clCentre?: number
  /** …its 95th percentile, px. */
  clCentreP95?: number
  /** Authored centreline not under the traced ink → nearest traced centreline, mean px (recall). */
  clMissed?: number
  /** Mean |w_traced − w_authored| / w_authored over matched samples. */
  clWidthErr?: number
  /** Open-path ends, traced − authored (after joining authored paths that meet end to end). */
  clEndsDelta?: number
  /** Stroke subpaths, traced − authored. */
  clPathsDelta?: number
  /** Traced paths that leave one authored stroke for another away from an end-to-end join. */
  clTurns?: number
}

// The vectorizer comparison's results, as /labs/bench reads them — pure, so the stats a
// table prints are the stats a test can check (node strips types from .ts, not .tsx).
//
// The rows are bench/compare/run.ts's `results.json`: one per (tool, case), every tool's
// output scored by the SAME pipeline (bench/compare/score.ts). Nothing here re-scores
// anything; it only groups, ranks and pairs what the run measured.

/** One scored (tool, case). Every number can be missing: geometry is n/a where the
 *  authored SVG is refused (strokes, clips) or the tool's output does not parse. */
export interface BenchRow {
  tool: string
  caseId: string
  corpus: string
  heldOut: boolean
  status: string
  lane: string
  notes?: string
  geomRefusal?: string | null
  gtRefusal?: string | null
  failedGates?: string[]
  gatesApplicable?: number
  gatesPassed?: number
  [metric: string]: unknown
}

export interface BenchCaseMeta {
  id: string
  lane: string
  license: string
  source: string
  gtRefusal: string | null
}

export interface BenchMeta {
  run: string
  date: string
  res: number
  logolab: string
  corpora: string[]
  tools: string[]
  versions: Record<string, string>
  provenance?: Record<string, unknown>
  svgbench?: Record<string, unknown>
  cases: BenchCaseMeta[]
}

export interface BenchResults {
  meta: BenchMeta
  rows: BenchRow[]
}

export interface RunInfo {
  name: string
  date: string | null
  corpora: string[]
  tools: string[]
  rows: number
  bytes: number
}

// ---------------------------------------------------------------------------
// What the columns mean

export type MetricGroup = 'pixel' | 'geometry' | 'literature' | 'size'

export interface Metric {
  key: string
  label: string
  /** Which direction is better. */
  better: 'lower' | 'higher'
  group: MetricGroup
  digits: number
  help: string
}

export const METRICS: Metric[] = [
  {
    key: 'meanDeltaE',
    label: 'ΔE mean',
    better: 'lower',
    group: 'pixel',
    digits: 2,
    help: 'Mean CIE76 colour error of the render against the authored render — the number the studio’s status bar shows.',
  },
  {
    key: 'chamfer',
    label: 'Chamfer',
    better: 'lower',
    group: 'geometry',
    digits: 2,
    help: 'Mean distance (px) between the traced boundary and the authored one, both ways.',
  },
  {
    key: 'p95',
    label: 'p95',
    better: 'lower',
    group: 'geometry',
    digits: 2,
    help: '95th-percentile boundary distance (px) — where the trace is worst.',
  },
  {
    key: 'nodeRatio',
    label: 'Nodes ÷ GT',
    better: 'lower',
    group: 'geometry',
    digits: 2,
    help: 'Traced nodes over the authored drawing’s nodes. 1.0 is as economical as the artist.',
  },
  {
    key: 'docNodes',
    label: 'Nodes',
    better: 'lower',
    group: 'size',
    digits: 0,
    help: 'Bézier nodes in the output.',
  },
  {
    key: 'tangentBreaks',
    label: 'Breaks',
    better: 'lower',
    group: 'geometry',
    digits: 0,
    help: 'Kinks (≥ 5°) on boundary the art draws smooth.',
  },
  {
    key: 'cornersInvented',
    label: 'Invented',
    better: 'lower',
    group: 'geometry',
    digits: 0,
    help: '60°+ corners the art does not have.',
  },
  {
    key: 'cornersRecovered',
    label: 'Corners kept',
    better: 'higher',
    group: 'geometry',
    digits: 0,
    help: 'Authored sharp corners the trace reproduces (out of the case’s gtCorners).',
  },
  {
    key: 'sbDino',
    label: 'DINO',
    better: 'higher',
    group: 'literature',
    digits: 4,
    help: 'SVG-Bench DinoScore: cosine similarity of DINOv2 features of render and authored render.',
  },
  {
    key: 'sbLpips',
    label: 'LPIPS',
    better: 'lower',
    group: 'literature',
    digits: 4,
    help: 'SVG-Bench LPIPS perceptual distance.',
  },
  {
    key: 'sbSsim',
    label: 'SSIM',
    better: 'higher',
    group: 'literature',
    digits: 4,
    help: 'SVG-Bench structural similarity.',
  },
  {
    key: 'sbMse',
    label: 'MSE',
    better: 'lower',
    group: 'literature',
    digits: 5,
    help: 'SVG-Bench mean squared pixel error (0–1 scale).',
  },
  {
    key: 'bytes',
    label: 'Bytes',
    better: 'lower',
    group: 'size',
    digits: 0,
    help: 'Size of the SVG file as written.',
  },
  {
    key: 'ms',
    label: 'ms',
    better: 'lower',
    group: 'size',
    digits: 0,
    help: 'Wall time per case. NOT comparable across tools: in-process and warm for LogoLab, process spawn + file I/O for the CLIs, GPU generation for StarVector.',
  },
]

export const METRIC_BY_KEY = new Map(METRICS.map((m) => [m.key, m]))

export const GROUP_LABEL: Record<MetricGroup, string> = {
  pixel: 'Pixels',
  geometry: 'Geometry (vs the authored SVG)',
  literature: 'SVG-Bench metrics',
  size: 'Size & time',
}

// ---------------------------------------------------------------------------
// Who the rows are

export type ToolFamily = 'logolab' | 'external' | 'reference' | 'ablation'

export interface ToolInfo {
  label: string
  family: ToolFamily
  blurb: string
}

/** Descriptions mirror bench/compare/adapters/*. A tool missing here still shows, by id. */
export const TOOL_INFO: Record<string, ToolInfo> = {
  'logolab-auto': {
    label: 'LogoLab',
    family: 'logolab',
    blurb:
      'What users get: the MCP traceIcon path. The ink probe picks Mono or Colour, the gradient probe decides on ramps, and small mono art is enlarged. No per-case knowledge. The headline row.',
  },
  'logolab-product': {
    label: 'LogoLab preset, no probes',
    family: 'ablation',
    blurb:
      'PRODUCT_VECTORIZE_OPTIONS applied blind (stacked, gradients on) with the probes skipped. The studio, the icon sheet and the MCP server all run the gradient probe first, so no shipped path does this; it is an ablation.',
  },
  'logolab-gate': {
    label: 'LogoLab (oracle)',
    family: 'reference',
    blurb:
      'The truth gate’s development configuration: tiled, with `gradients` read off the authored SVG, which no other tool gets to see. A reference row, not a result.',
  },
  'vtracer-default': {
    label: 'VTracer',
    family: 'external',
    blurb: 'VTracer 0.6.4, CLI defaults (colour, stacked, spline).',
  },
  'vtracer-poster': {
    label: 'VTracer poster',
    family: 'external',
    blurb: 'VTracer 0.6.4 `--preset poster` (colour precision 8).',
  },
  'vtracer-swept': {
    label: 'VTracer swept',
    family: 'external',
    blurb:
      'The best of a 54-config sweep of VTracer on held-out cases (bench/compare/sweepVtracer.ts): -p 6 -g 8 -f 2, cutout.',
  },
  'starvector-1b': {
    label: 'StarVector-1B',
    family: 'external',
    blurb:
      'starvector/starvector-1b-im2svg, the repo’s own SVG-Bench generation config (fp16, T 0.2, top-p 0.95). The 8B model does not fit in 16 GB.',
  },
  'autotrace-default': {
    label: 'AutoTrace',
    family: 'external',
    blurb:
      'AutoTrace 0.40.0 with no flags, on a PPM of the same raster (this build reads no PNG). Every exact colour is traced, so each anti-aliased edge tone becomes its own sliver. StarVector’s paper reports it on SVG-Emoji.',
  },
  'autotrace-swept': {
    label: 'AutoTrace swept',
    family: 'external',
    blurb:
      'The best of a 32-config sweep of AutoTrace (colour count, despeckle level, error threshold) picked on the in-sample corpora only (bench/compare/sweepAutotrace.ts), as VTracer swept is.',
  },
  'omnisvg-4b': {
    label: 'OmniSVG-4B',
    family: 'external',
    blurb:
      'OmniSVG1.1_4B (NeurIPS 2025) on Qwen2.5-VL-3B, through the repo’s own inference.py: its prompt, its sampling defaults (T 0.3, top-p 0.9) and its rule of keeping the first sample that renders, with seed 0. Output in a 200-unit viewBox.',
  },
  potrace: {
    label: 'Potrace',
    family: 'external',
    blurb: 'Potrace 1.16, painted in the case’s ink. It runs only on mono-lane cases, so its n is tiny.',
  },
  'potrace-bin': {
    label: 'Potrace (binarised)',
    family: 'external',
    blurb:
      'SVG-Bench’s protocol: every case cut at luma 128 and traced in black, so it cannot get a colour right. It is here because the paper reports it.',
  },
  'logolab-abl-tiled-grad': {
    label: 'Ablation: tiled + gradients',
    family: 'ablation',
    blurb: 'Tiled layering, gradients ON, no probes.',
  },
  'logolab-abl-tiled-nograd': {
    label: 'Ablation: tiled, flat',
    family: 'ablation',
    blurb: 'Tiled layering, gradients OFF, no probes.',
  },
  'logolab-abl-stacked-nograd': {
    label: 'Ablation: stacked, flat',
    family: 'ablation',
    blurb: 'Stacked layering, gradients OFF, no probes.',
  },
}

export const HEADLINE_TOOL = 'logolab-auto'

export function toolInfo(tool: string): ToolInfo {
  return TOOL_INFO[tool] ?? { label: tool, family: 'external', blurb: '' }
}

export const FAMILY_LABEL: Record<ToolFamily, string> = {
  logolab: 'LogoLab',
  external: 'Other vectorizers',
  reference: 'Reference (has an oracle)',
  ablation: 'Ablations',
}

// ---------------------------------------------------------------------------
// Where the cases come from

export interface CorpusInfo {
  label: string
  heldOut: boolean
  blurb: string
  source: string
  sourceUrl?: string
  license: string
}

export const CORPUS_INFO: Record<string, CorpusInfo> = {
  'svgemoji-v0': {
    label: 'SVG-Bench emoji · 100',
    heldOut: true,
    blurb:
      '100 Twemoji from the test split of StarVector’s SVG-Bench `svg-emoji`: fill-only, one per base emoji, picked in sha1 order. LogoLab was never tuned on them. The headline corpus.',
    source: 'starvector/svg-emoji (Hugging Face), pinned revision + parquet sha256',
    sourceUrl: 'https://huggingface.co/datasets/starvector/svg-emoji',
    license: 'CC-BY 4.0 (Twemoji)',
  },
  svgemoji: {
    label: 'SVG-Bench emoji · all 668',
    heldOut: true,
    blurb:
      'The whole test split the StarVector paper’s SVG-Emoji row is measured on: Twemoji, OpenMoji and Noto. OpenMoji is stroked, so its geometry is refused and only pixel metrics apply there.',
    source: 'starvector/svg-emoji (Hugging Face)',
    sourceUrl: 'https://huggingface.co/datasets/starvector/svg-emoji',
    license: 'CC-BY 4.0 / CC-BY-SA 4.0 / Apache-2.0 (per emoji set)',
  },
  truth0: {
    label: 'Truth gate tier 0',
    heldOut: false,
    blurb:
      'LogoLab’s handcrafted fixtures, one named failure mode each. In-sample: the tracer was developed against them, so they can explain a result but not support one.',
    source: 'bench/truthCorpus.ts (tier 0)',
    license: 'LogoLab fixtures',
  },
  fluent2: {
    label: 'Fluent Emoji, flat',
    heldOut: false,
    blurb:
      'Every 4th tier-2 case: Microsoft Fluent Emoji authored flat. In-sample: measured against during development.',
    source: 'microsoft/fluentui-emoji via bench/vendorFluentEmoji.ts',
    sourceUrl: 'https://github.com/microsoft/fluentui-emoji',
    license: 'MIT',
  },
}

export function corpusInfo(id: string): CorpusInfo {
  return CORPUS_INFO[id] ?? { label: id, heldOut: false, blurb: '', source: '', license: '' }
}

// ---------------------------------------------------------------------------
// Stats

export function num(row: BenchRow | undefined, key: string): number | null {
  const v = row?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export interface Dist {
  n: number
  median: number
  mean: number
  p25: number
  p75: number
  min: number
  max: number
  values: number[]
}

export function dist(values: number[]): Dist {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  const mean = v.reduce((s, x) => s + x, 0) / (v.length || 1)
  return {
    n: v.length,
    median: quantile(v, 0.5),
    mean: v.length ? mean : Number.NaN,
    p25: quantile(v, 0.25),
    p75: quantile(v, 0.75),
    min: v.length ? v[0] : Number.NaN,
    max: v.length ? v[v.length - 1] : Number.NaN,
    values: v,
  }
}

/** case id → tool → row, for one corpus. */
export function caseTable(rows: BenchRow[], corpus: string): Map<string, Map<string, BenchRow>> {
  const out = new Map<string, Map<string, BenchRow>>()
  for (const r of rows) {
    if (r.corpus !== corpus) continue
    let byTool = out.get(r.caseId)
    if (!byTool) out.set(r.caseId, (byTool = new Map()))
    byTool.set(r.tool, r)
  }
  return out
}

export interface ToolSummary {
  tool: string
  n: number
  failures: number
  gatesAllPass: number
  regionsAll: number
  metrics: Record<string, Dist>
}

export function summarize(rows: BenchRow[], corpus: string, tools: string[]): ToolSummary[] {
  return tools
    .map((tool) => {
      const mine = rows.filter((r) => r.corpus === corpus && r.tool === tool)
      const metrics: Record<string, Dist> = {}
      for (const m of METRICS) metrics[m.key] = dist(mine.map((r) => num(r, m.key)).filter((v) => v !== null))
      return {
        tool,
        n: mine.length,
        failures: mine.filter((r) => r.status !== 'ok').length,
        gatesAllPass: mine.filter((r) => (r.gatesApplicable ?? 0) > 0 && r.gatesPassed === r.gatesApplicable).length,
        regionsAll: mine.filter((r) => num(r, 'regionsTrue') !== null && r.regionsRecovered === r.regionsTrue).length,
        metrics,
      }
    })
    .filter((s) => s.n > 0)
}

/** Deterministic PRNG for the bootstrap — the same table every reload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Paired {
  /** Cases where both tools have the metric. */
  n: number
  /** Mean of (tool − reference). */
  meanDiff: number
  /** 95% paired-bootstrap interval of that mean. */
  lo: number
  hi: number
  /** The interval excludes 0. */
  significant: boolean
  /** Cases the TOOL is strictly better on, in the metric's own direction. */
  wins: number
  losses: number
}

/** Pair `tool` against `ref` case by case on one metric — report.ts's test, same seed
 *  convention: a fixed seed per call so a reload never reshuffles the verdict. */
export function paired(
  table: Map<string, Map<string, BenchRow>>,
  tool: string,
  ref: string,
  metric: Metric,
  resamples = 2000,
): Paired | null {
  const d: number[] = []
  let wins = 0
  let losses = 0
  for (const byTool of table.values()) {
    const a = num(byTool.get(tool), metric.key)
    const b = num(byTool.get(ref), metric.key)
    if (a === null || b === null) continue
    d.push(a - b)
    const better = metric.better === 'lower' ? a < b : a > b
    const worse = metric.better === 'lower' ? a > b : a < b
    if (better) wins++
    else if (worse) losses++
  }
  if (d.length < 2) return null
  const mean = d.reduce((s, x) => s + x, 0) / d.length
  const rand = mulberry32(0x5eed)
  const means: number[] = []
  for (let k = 0; k < resamples; k++) {
    let s = 0
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]
    means.push(s / d.length)
  }
  means.sort((x, y) => x - y)
  const lo = quantile(means, 0.025)
  const hi = quantile(means, 0.975)
  return { n: d.length, meanDiff: mean, lo, hi, significant: lo > 0 || hi < 0, wins, losses }
}

export function fmt(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (digits === 0 && Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`
  return v.toFixed(digits)
}

/** Per-case file names inside `cases/<corpus>/<name>/`, as run.ts writes them. */
export function caseDir(caseId: string): string {
  return `cases/${caseId}`
}

/** The tools a case view shows unless asked for more: one of each kind, not three VTracers. */
export const CORE_TOOLS = ['logolab-auto', 'vtracer-default', 'starvector-1b', 'potrace-bin']

/**
 * How much a metric favours tool `a` over `b` on one case: positive when `a` is better, in
 * the metric's own units, whichever direction "better" is. Null when either is unscored.
 */
export function favour(byTool: Map<string, BenchRow> | undefined, a: string, b: string, metric: Metric): number | null {
  const va = num(byTool?.get(a), metric.key)
  const vb = num(byTool?.get(b), metric.key)
  if (va === null || vb === null) return null
  return metric.better === 'lower' ? vb - va : va - vb
}

export interface Disagreement {
  caseId: string
  /** favour() on the x metric and the y metric. */
  x: number
  y: number
}

/** Every case where both metrics scored both tools — the Compare tab's quadrant plot. Points
 *  with x and y of opposite sign are the cases where the two metrics name different winners. */
export function disagreements(
  table: Map<string, Map<string, BenchRow>>,
  a: string,
  b: string,
  mx: Metric,
  my: Metric,
): Disagreement[] {
  const out: Disagreement[] = []
  for (const [caseId, byTool] of table) {
    const x = favour(byTool, a, b, mx)
    const y = favour(byTool, a, b, my)
    if (x !== null && y !== null) out.push({ caseId, x, y })
  }
  return out
}

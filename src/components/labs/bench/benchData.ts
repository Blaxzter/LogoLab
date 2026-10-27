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
  /** false: a published run that ships SVGs only (benchSource.ts). Absent = PNGs present. */
  renders?: boolean
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

/** Where a tool comes from: its paper when it has one, and its code. */
export interface ToolRef {
  /** The tool's name, without a configuration. */
  name: string
  /** Authors, title, venue and year, as cited. Absent for a tool with no paper. */
  paper?: string
  paperUrl?: string
  code: string
  license: string
}

/** One entry per tool, however many configurations it runs in; `toolRef` maps a row to it. */
export const TOOL_REFS: Record<string, ToolRef> = {
  logolab: { name: 'LogoLab', code: 'https://github.com/Blaxzter/LogoLab', license: 'MIT' },
  vtracer: { name: 'VTracer', code: 'https://github.com/visioncortex/vtracer', license: 'MIT' },
  potrace: {
    name: 'Potrace',
    paper: 'P. Selinger. Potrace: a polygon-based tracing algorithm. 2003.',
    paperUrl: 'https://potrace.sourceforge.net/potrace.pdf',
    code: 'https://potrace.sourceforge.net/',
    license: 'GPL-2.0-or-later',
  },
  autotrace: { name: 'AutoTrace', code: 'https://github.com/autotrace/autotrace', license: 'GPL-2.0' },
  imagetracer: {
    name: 'ImageTracer.js',
    code: 'https://github.com/jankovicsandras/imagetracerjs',
    license: 'Unlicense',
  },
  starvector: {
    name: 'StarVector',
    paper:
      'J. A. Rodriguez et al. StarVector: generating scalable vector graphics code from images and text. CVPR 2025.',
    paperUrl: 'https://arxiv.org/abs/2312.11556',
    code: 'https://github.com/joanrod/star-vector',
    license: 'Apache-2.0',
  },
  omnisvg: {
    name: 'OmniSVG',
    paper: 'Y. Yang et al. OmniSVG: a unified scalable vector graphics generation model. NeurIPS 2025.',
    paperUrl: 'https://arxiv.org/abs/2504.06263',
    code: 'https://github.com/OmniSVG/OmniSVG',
    license: 'Apache-2.0',
  },
}

/** The reference for a result row: `vtracer-swept` → VTracer, `logolab-abl-…` → LogoLab. */
export function toolRef(tool: string): ToolRef | undefined {
  return TOOL_REFS[tool.split('-')[0]]
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
      'The best of a 54-config sweep of VTracer picked on the in-sample corpora only (bench/compare/sweepVtracer.ts): -p 6 -g 8 -f 2, cutout.',
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
  'imagetracer-default': {
    label: 'ImageTracer',
    family: 'external',
    blurb:
      'ImageTracer.js 1.2.6 with its default preset: 16 colours, then each colour layer traced to lines and quadratic curves. It strokes every path 1 px in its own colour to hide the seams between layers, so only its picture can be scored.',
  },
  'imagetracer-fills': {
    label: 'ImageTracer fills',
    family: 'external',
    blurb:
      'ImageTracer.js default preset with its own strokewidth 0 switch: the same shapes without the seam-hiding stroke, so the drawing metrics can be read on it.',
  },
  'imagetracer-swept': {
    label: 'ImageTracer swept',
    family: 'external',
    blurb:
      'The best of a 24-config sweep of ImageTracer.js (colours, line and curve thresholds, path omission, always unstroked) picked on the in-sample corpora only (bench/compare/sweepImagetracer.ts), as VTracer swept is.',
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
  'logos-cc0': {
    label: 'Open logos (CC0) · 300',
    heldOut: true,
    blurb:
      '300 brand marks from gilbarbara/logos at a pinned commit, stratified by colour count, gradients and wordmark vs symbol, picked in sha1 order. Strokes, masks and filters are kept (pixel metrics only). Brands in LogoLab’s own gallery corpus are excluded, so none of it was tuned on. The logo headline. CC0 covers the artwork; the marks remain their owners’ trademarks.',
    source: 'gilbarbara/logos (GitHub), pinned commit + per-file sha256 (bench/compare/manifests/logos-cc0.json)',
    sourceUrl: 'https://github.com/gilbarbara/logos',
    license: 'CC0 1.0 (artwork; marks are trademarks)',
  },
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

// ---------------------------------------------------------------------------
// Mean rank: the benchmark's one headline number
//
// Every metric above has its own unit and its own direction, and a "score" that adds them
// needs a weight per metric and usually a threshold per metric ("chamfer ≤ 1 px passes"):
// numbers somebody picked, which then decide the winner. Ranks need neither. Per CASE and
// per METRIC the tools are ranked 1 = best (ties share the average rank), and a tool's mean
// rank is the mean over every (case, metric) cell. The one choice left is WHICH metrics,
// and that is RANK_METRICS below, one fixed list per kind of corpus.
//
// Three rules decide what a cell is, and each is easy to get backwards:
//
//   • A tool whose OWN output failed (status ≠ 'ok') or was refused for a metric (no value:
//     geomRefusal, an output that does not parse) is ranked tied-LAST in that cell, never
//     skipped. Skipping would reward failing: a tool that crashes on every hard case would
//     be ranked on the easy ones only. A failed row's white-render ΔE is not used either —
//     the row failed, so it is last in every cell, as it is on geometry.
//   • A metric the GROUND TRUTH refuses on a case (gtRefusal: stroked or clipped authored
//     art has no answer sheet for geometry) is left out of that case for EVERY tool. Nobody
//     could have been measured there, so nobody is last.
//   • A cell no tool has a value for (a metric the run did not measure, a case with no
//     interior boundary so chamfer is undefined for everyone) is left out too: every tool
//     would tie at the middle, and the cell would only pull the field together.
//
// A tool is ranked on a corpus only when it has a row on EVERY case there. Friedman's test
// needs complete blocks, and a missing row is not a failure: Potrace runs only on mono-lane
// cases, it was never given the others. Such a tool is listed in `excluded` with its n.
//
// Which tools: the HEADLINE ranks each tool as its users get it: LogoLab's shipped path
// (logolab-auto), every other tool's defaults and its own named presets. Rows that are an
// ANALYSIS rather than a tool are never in it (isAblationRow): LogoLab's oracle row
// (logolab-gate reads `gradients` off the authored SVG), its no-probe preset and its
// ablation grid, and every `-swept` variant (the best of a grid search is a selection made
// by looking at scores, even when, as here, the scores were in-sample ones). The ABLATION
// VIEW ranks everything, and is labelled so wherever it is printed.
//
// Which corpora: held-out only, and ONE LEADERBOARD PER CORPUS. A fill corpus and a line
// corpus are ranked on different metrics, so their ranks answer different questions, and an
// average of the two would depend on how many cases each corpus happens to hold.

export type CorpusKind = 'fill' | 'line'

export interface RankMetric {
  /** ScoreRow field. */
  key: string
  label: string
  better: 'lower' | 'higher'
  /** Ranked on |value| (a delta whose best is 0 from either side). */
  abs?: boolean
  /** Needs the authored geometry: left out of a case whose ground truth is refused. */
  ground: boolean
}

/**
 * The metrics a corpus is ranked on, by kind. One per question, not every column: ranking
 * three correlated boundary distances would count the outline three times.
 *
 *   fill  colour error, edge error, node count, kinks on smooth curves, and SVG-Bench's DINO
 *         (the literature's own number, so a tool cannot top the board on our metrics alone
 *         without it showing)
 *   line  the centreline scorer (bench/centerlineScore.ts): centre distance, missed ink,
 *         width error, |traced − authored paths|, strokes that turn onto another stroke;
 *         plus colour error and node count
 */
export const RANK_METRICS: Record<CorpusKind, RankMetric[]> = {
  fill: [
    { key: 'meanDeltaE', label: 'ΔE', better: 'lower', ground: false },
    { key: 'chamfer', label: 'Edge px', better: 'lower', ground: true },
    { key: 'docNodes', label: 'Nodes', better: 'lower', ground: false },
    { key: 'tangentBreaks', label: 'Kinks', better: 'lower', ground: true },
    { key: 'sbDino', label: 'DINO', better: 'higher', ground: false },
  ],
  line: [
    { key: 'clCentre', label: 'Centre px', better: 'lower', ground: true },
    { key: 'clMissed', label: 'Missed px', better: 'lower', ground: true },
    { key: 'clWidthErr', label: 'Width err', better: 'lower', ground: true },
    { key: 'clPathsDelta', label: '|Paths Δ|', better: 'lower', abs: true, ground: true },
    { key: 'clTurns', label: 'Turns', better: 'lower', ground: true },
    { key: 'meanDeltaE', label: 'ΔE', better: 'lower', ground: false },
    { key: 'docNodes', label: 'Nodes', better: 'lower', ground: false },
  ],
}

/** Corpora ranked as LINE art (strokes, by the centreline scorer). Every other one is fill. */
export const LINE_CORPORA: ReadonlySet<string> = new Set(['strokes-oss'])

export function corpusKind(corpus: string): CorpusKind {
  return LINE_CORPORA.has(corpus) ? 'line' : 'fill'
}

/** A row that is an analysis, not a tool as its users get it: never in the headline. */
export function isAblationRow(tool: string): boolean {
  const family = toolInfo(tool).family
  return /^logolab-abl-/.test(tool) || /-swept$/.test(tool) || family === 'ablation' || family === 'reference'
}

export type RankView = 'headline' | 'ablation'

export interface RankOpts {
  corpus: string
  /** 'headline' (default) leaves out isAblationRow; 'ablation' ranks every tool. */
  view?: RankView
  /** Default RANK_METRICS[corpusKind(corpus)]. */
  metrics?: RankMetric[]
  /** Bootstrap resamples of the cases for the CI (default 2000). */
  resamples?: number
  seed?: number
}

/** One case: the metrics it was ranked on, and per metric each tool's rank. */
export interface CaseRanks {
  caseId: string
  metrics: string[]
  /** ranks[m][t]: metric `metrics[m]`, tool `tools[t]`. */
  ranks: number[][]
}

export interface RankedCorpus {
  corpus: string
  kind: CorpusKind
  view: RankView
  tools: string[]
  excluded: { tool: string; n: number; reason: string }[]
  metrics: RankMetric[]
  cases: CaseRanks[]
  /** Cells left out: the ground truth refused the metric / no tool had a value. */
  dropped: { ground: number; unmeasured: number }
}

/** Rank one cell: 1 = best in the metric's direction, ties share the average rank, and a
 *  null (failed or refused) is tied LAST with the other nulls. */
export function rankCell(values: (number | null)[], better: 'lower' | 'higher'): number[] {
  const out = new Array<number>(values.length)
  const scored = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null)
    .sort((a, b) => (better === 'lower' ? a.v - b.v : b.v - a.v))
  for (let s = 0; s < scored.length; ) {
    let e = s
    while (e + 1 < scored.length && scored[e + 1].v === scored[s].v) e++
    const r = (s + e) / 2 + 1
    for (let j = s; j <= e; j++) out[scored[j].i] = r
    s = e + 1
  }
  const last = (scored.length + 1 + values.length) / 2
  for (let i = 0; i < values.length; i++) if (values[i] === null) out[i] = last
  return out
}

/** The (case, metric) rank cells of one corpus: what meanRanks and paretoWins both read. */
export function rankCases(rows: BenchRow[], opts: RankOpts): RankedCorpus {
  const view = opts.view ?? 'headline'
  const kind = corpusKind(opts.corpus)
  const metrics = opts.metrics ?? RANK_METRICS[kind]
  const table = caseTable(rows, opts.corpus)
  const caseIds = [...table.keys()]
  const seen: string[] = []
  for (const r of rows) if (r.corpus === opts.corpus && !seen.includes(r.tool)) seen.push(r.tool)
  const tools: string[] = []
  const excluded: RankedCorpus['excluded'] = []
  for (const t of seen.filter((t) => view === 'ablation' || !isAblationRow(t))) {
    const n = caseIds.filter((c) => table.get(c)?.has(t)).length
    if (n === caseIds.length) tools.push(t)
    else excluded.push({ tool: t, n, reason: `a row on ${n} of ${caseIds.length} cases; it was not given the rest` })
  }
  const dropped = { ground: 0, unmeasured: 0 }
  const cases: CaseRanks[] = []
  for (const [caseId, byTool] of table) {
    const groundRefused = [...byTool.values()].some((r) => !!r.gtRefusal)
    const keys: string[] = []
    const ranks: number[][] = []
    for (const m of metrics) {
      if (m.ground && groundRefused) {
        dropped.ground++
        continue
      }
      const values = tools.map((t) => {
        const r = byTool.get(t)
        if (!r || r.status !== 'ok') return null
        const v = num(r, m.key)
        return v === null ? null : m.abs ? Math.abs(v) : v
      })
      if (values.every((v) => v === null)) {
        dropped.unmeasured++
        continue
      }
      keys.push(m.key)
      ranks.push(rankCell(values, m.better))
    }
    cases.push({ caseId, metrics: keys, ranks })
  }
  return { corpus: opts.corpus, kind, view, tools, excluded, metrics, cases, dropped }
}

export interface ToolRank {
  tool: string
  /** Mean over every (case, metric) cell: the headline number. */
  mean: number
  /** 95% bootstrap interval of `mean`, resampling CASES (a case's cells move together). */
  lo: number
  hi: number
  /** Mean over cases of the tool's rank averaged over that case's metrics: what the
   *  Friedman test and the CD diagram are on. Equal to `mean` whenever every case is ranked
   *  on the same number of metrics. */
  caseMean: number
  cells: number
  /** Per-metric mean rank (the breakdown); null for a metric no case was ranked on. */
  perMetric: Record<string, number | null>
}

export interface MeanRanks extends RankedCorpus {
  /** Cases ranked on at least one metric: the N of the tests. */
  n: number
  /** Best first. */
  ranking: ToolRank[]
  /** blocks[case][tool]: the tool's rank averaged over that case's metrics, `tools` order. */
  blocks: number[][]
}

/** Mean rank per tool on one corpus, best first, with the per-metric breakdown and a seeded
 *  case-bootstrap CI (no Math.random: the same interval on every run and every reload). */
export function meanRanks(rows: BenchRow[], opts: RankOpts): MeanRanks {
  const rc = rankCases(rows, opts)
  const k = rc.tools.length
  const used = rc.cases.filter((c) => c.metrics.length > 0)
  const sums = used.map((c) => rc.tools.map((_, t) => c.ranks.reduce((s, r) => s + r[t], 0)))
  const counts = used.map((c) => c.metrics.length)
  const blocks = sums.map((row, i) => row.map((s) => s / counts[i]))
  const total = counts.reduce((a, b) => a + b, 0)
  const B = opts.resamples ?? 2000
  const rand = mulberry32(opts.seed ?? 0x5eed)
  const boot: number[][] = rc.tools.map(() => [])
  if (used.length > 0)
    for (let b = 0; b < B; b++) {
      const s = new Array<number>(k).fill(0)
      let c = 0
      for (let i = 0; i < used.length; i++) {
        const j = Math.floor(rand() * used.length)
        for (let t = 0; t < k; t++) s[t] += sums[j][t]
        c += counts[j]
      }
      for (let t = 0; t < k; t++) boot[t].push(s[t] / c)
    }
  const ranking: ToolRank[] = rc.tools.map((tool, t) => {
    const perMetric: Record<string, number | null> = {}
    for (const m of rc.metrics) {
      let s = 0
      let n = 0
      for (const c of used) {
        const i = c.metrics.indexOf(m.key)
        if (i < 0) continue
        s += c.ranks[i][t]
        n++
      }
      perMetric[m.key] = n ? s / n : null
    }
    const sorted = boot[t].sort((a, b) => a - b)
    return {
      tool,
      mean: total ? sums.reduce((a, row) => a + row[t], 0) / total : Number.NaN,
      lo: quantile(sorted, 0.025),
      hi: quantile(sorted, 0.975),
      caseMean: blocks.length ? blocks.reduce((a, row) => a + row[t], 0) / blocks.length : Number.NaN,
      cells: total,
      perMetric,
    }
  })
  ranking.sort((a, b) => a.mean - b.mean || a.tool.localeCompare(b.tool))
  return { ...rc, n: used.length, ranking, blocks }
}

// --- the tests on the ranks ----------------------------------------------------

/** ln Γ(x), Lanczos (g = 7, n = 9): ~15 digits for x > 0. */
function lnGamma(x: number): number {
  const c = [
    0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.61503916999186,
    12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  const z = x - 1
  let a = c[0]
  const t = z + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (z + i)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

const TINY = 1e-300
const EPS = 1e-15

/** Upper regularized incomplete gamma Q(a, x): series below a + 1, continued fraction above
 *  (Numerical Recipes' gser / gcf). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1
  const lead = Math.exp(-x + a * Math.log(x) - lnGamma(a))
  if (x < a + 1) {
    let sum = 1 / a
    let del = sum
    for (let n = 1; n < 1000; n++) {
      del *= x / (a + n)
      sum += del
      if (Math.abs(del) < Math.abs(sum) * EPS) break
    }
    return 1 - sum * lead
  }
  let b = x + 1 - a
  let c = 1 / TINY
  let d = 1 / b
  let h = d
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < TINY) d = TINY
    c = b + an / c
    if (Math.abs(c) < TINY) c = TINY
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return lead * h
}

/** Continued fraction of the incomplete beta (Numerical Recipes' betacf). */
function betaCf(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < TINY) d = TINY
  d = 1 / d
  let h = d
  for (let m = 1; m < 1000; m++) {
    const m2 = 2 * m
    for (const aa of [
      (m * (b - m) * x) / ((qam + m2) * (a + m2)),
      (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2)),
    ]) {
      d = 1 + aa * d
      if (Math.abs(d) < TINY) d = TINY
      c = 1 + aa / c
      if (Math.abs(c) < TINY) c = TINY
      d = 1 / d
      h *= d * c
    }
    if (Math.abs(d * c - 1) < EPS) break
  }
  return h
}

/** Regularized incomplete beta I_x(a, b). */
function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(x, a, b)) / a : 1 - (front * betaCf(1 - x, b, a)) / b
}

/** P(χ²_df ≥ x). */
export function chi2Sf(x: number, df: number): number {
  return gammaQ(df / 2, x / 2)
}

/** P(F_{d1,d2} ≥ f). */
export function fSf(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1
  if (!Number.isFinite(f)) return 0
  return betaI(d2 / (d2 + d1 * f), d2 / 2, d1 / 2)
}

export interface Friedman {
  k: number
  n: number
  /** Friedman's χ²_F, k − 1 degrees of freedom. */
  chi2: number
  df: number
  p: number
  /** Iman–Davenport F_F = (N−1)χ²_F / (N(k−1) − χ²_F) on (k−1, (k−1)(N−1)) df: χ²_F is
   *  needlessly conservative, and this is the statistic Demšar recommends reporting. */
  ff: number
  df1: number
  df2: number
  pF: number
}

/** Friedman's test from the tools' mean ranks over `n` blocks (Demšar 2006, §3.2.2):
 *  χ²_F = 12N / (k(k+1)) · (Σ_j R_j² − k(k+1)²/4). */
export function friedmanFromMeans(means: number[], n: number): Friedman | null {
  const k = means.length
  if (k < 2 || n < 2) return null
  const chi2 = ((12 * n) / (k * (k + 1))) * (means.reduce((s, r) => s + r * r, 0) - (k * (k + 1) ** 2) / 4)
  const df1 = k - 1
  const df2 = (k - 1) * (n - 1)
  const den = n * (k - 1) - chi2
  const ff = den > 0 ? ((n - 1) * chi2) / den : Number.POSITIVE_INFINITY
  return { k, n, chi2, df: df1, p: chi2Sf(chi2, df1), ff, df1, df2, pF: fSf(ff, df1, df2) }
}

/**
 * Friedman's test on one row of ranks per case (blocks[case][tool]). The benchmark's rows
 * are each tool's rank AVERAGED over the case's metrics (meanRanks().blocks), not re-ranked.
 * An average of ranks varies less than a rank does, so under the null χ²_F comes out smaller
 * than its reference distribution assumes and the test errs CONSERVATIVE: a difference it
 * calls significant is at least that significant. The CD diagram can then plot the same
 * means the test was on.
 */
export function friedman(blocks: number[][]): Friedman | null {
  const n = blocks.length
  const k = blocks[0]?.length ?? 0
  if (!n || !k) return null
  const means = Array.from({ length: k }, (_, t) => blocks.reduce((s, b) => s + b[t], 0) / n)
  return friedmanFromMeans(means, n)
}

/**
 * Critical values q_α of the two-tailed Nemenyi test for k = 2..20 tools (index k − 2): the
 * studentized range with infinite degrees of freedom, divided by √2. k = 2..10 are Table 5(a)
 * of J. Demšar, "Statistical Comparisons of Classifiers over Multiple Data Sets", JMLR
 * 7:1–30 (2006), as printed; k = 11..20 are computed from the same distribution (numerical
 * integration of the range of k standard normals, the computation test/bench-rank.test.ts
 * checks against Demšar's ten printed values).
 */
export const NEMENYI_Q: Record<'0.05' | '0.10', number[]> = {
  '0.05': [
    1.96, 2.343, 2.569, 2.728, 2.85, 2.949, 3.031, 3.102, 3.164, 3.219, 3.268, 3.313, 3.354, 3.391, 3.426, 3.458, 3.489,
    3.517, 3.544,
  ],
  '0.10': [
    1.645, 2.052, 2.291, 2.459, 2.589, 2.693, 2.78, 2.855, 2.92, 2.978, 3.03, 3.077, 3.12, 3.159, 3.196, 3.23, 3.261,
    3.291, 3.319,
  ],
}

/** Nemenyi critical difference CD = q_α √(k(k+1) / (6N)): two tools whose mean ranks differ
 *  by less are not significantly different. Null outside k = 2..20. */
export function nemenyiCD(k: number, n: number, alpha: 0.05 | 0.1 = 0.05): number | null {
  const q = NEMENYI_Q[alpha === 0.05 ? '0.05' : '0.10'][k - 2]
  if (q === undefined || n < 1) return null
  return q * Math.sqrt((k * (k + 1)) / (6 * n))
}

/** Groups a CD diagram joins with a bar: maximal runs of tools, in ascending mean-rank order,
 *  whose spread is under `cd`, as [first, last] indices into `sortedMeans`. A run inside
 *  another is not drawn, as in Demšar's figures. */
export function cdGroups(sortedMeans: number[], cd: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < sortedMeans.length; i++) {
    let j = i
    while (j + 1 < sortedMeans.length && sortedMeans[j + 1] - sortedMeans[i] < cd) j++
    if (j > i && !out.some(([a, b]) => a <= i && b >= j)) out.push([i, j])
  }
  return out
}

export interface ParetoRecord {
  tool: string
  /** (case, opponent) pairs compared: cases with a ranked metric × (k − 1). */
  pairs: number
  /** Shares of `pairs`; win + loss + incomparable + tie = 1. */
  win: number
  loss: number
  /** Better on one metric, worse on another: neither dominates. */
  incomparable: number
  /** Level on every metric. */
  tie: number
}

/**
 * Pareto win rate: on a case, A beats B when A is at least as good on every metric ranked
 * there and strictly better on one. Read off the cells' ranks, so a failed output is worse
 * than any scored one and level with another failure, exactly as in the mean rank. No
 * weights here either; the price is the `incomparable` share, which is most of the pairs
 * whenever two tools trade one metric for another.
 */
export function paretoWins(rows: BenchRow[], opts: RankOpts): ParetoRecord[] {
  const rc = rankCases(rows, opts)
  const k = rc.tools.length
  const tally = rc.tools.map(() => ({ pairs: 0, win: 0, loss: 0, incomparable: 0, tie: 0 }))
  for (const c of rc.cases) {
    if (!c.metrics.length) continue
    for (let a = 0; a < k; a++)
      for (let b = 0; b < k; b++) {
        if (a === b) continue
        let better = false
        let worse = false
        for (const r of c.ranks) {
          if (r[a] < r[b]) better = true
          else if (r[a] > r[b]) worse = true
        }
        const t = tally[a]
        t.pairs++
        if (better && !worse) t.win++
        else if (worse && !better) t.loss++
        else if (better && worse) t.incomparable++
        else t.tie++
      }
  }
  return rc.tools.map((tool, i) => {
    const t = tally[i]
    const d = t.pairs || 1
    return { tool, pairs: t.pairs, win: t.win / d, loss: t.loss / d, incomparable: t.incomparable / d, tie: t.tie / d }
  })
}

/** Everything a leaderboard prints for one corpus and one view. */
export interface Leaderboard {
  corpus: string
  kind: CorpusKind
  view: RankView
  /** Cases (Friedman blocks) and tools ranked. */
  n: number
  k: number
  metrics: { key: string; label: string; better: 'lower' | 'higher' }[]
  /** Best mean rank first. */
  tools: (ToolRank & { pareto: ParetoRecord })[]
  excluded: { tool: string; n: number; reason: string }[]
  dropped: { ground: number; unmeasured: number }
  friedman: Friedman | null
  cd05: number | null
  cd10: number | null
}

export function leaderboard(rows: BenchRow[], opts: RankOpts): Leaderboard {
  const mr = meanRanks(rows, opts)
  const pareto = new Map(paretoWins(rows, opts).map((p) => [p.tool, p]))
  const k = mr.tools.length
  return {
    corpus: mr.corpus,
    kind: mr.kind,
    view: mr.view,
    n: mr.n,
    k,
    metrics: mr.metrics.map((m) => ({ key: m.key, label: m.label, better: m.better })),
    tools: mr.ranking.map((r) => ({ ...r, pareto: pareto.get(r.tool) as ParetoRecord })),
    excluded: mr.excluded,
    dropped: mr.dropped,
    friedman: friedman(mr.blocks),
    cd05: nemenyiCD(k, mr.n, 0.05),
    cd10: nemenyiCD(k, mr.n, 0.1),
  }
}

/** The corpora a headline is computed on: held out, in the order the rows list them. */
export function headlineCorpora(rows: BenchRow[]): string[] {
  const out: string[] = []
  for (const r of rows) if (r.heldOut && !out.includes(r.corpus)) out.push(r.corpus)
  return out
}

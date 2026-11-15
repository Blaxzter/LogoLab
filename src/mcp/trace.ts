// Auto-trace: an image an agent just generated → a clean SVG, with the decisions
// made for it.
//
// Everything here is the app's own pipeline, headless. The decisions the studio
// makes for a human — colour vs mono, where a mono cut falls, whether the art has
// real gradients, what resolution to trace at — are `planTileTrace` (src/lib/sheet),
// and the trace itself is `traceTile`, the same function the icon-sheet batch and
// the single-icon editor run. The plan is reported back so an agent can
// overrule one decision without hand-tuning the rest.
//
// `search` checks the probes instead of trusting them: the decisions the request
// left on auto (mode, gradients) are each traced, every candidate is scored
// against the source with the shipped ΔE (lib/render/fidelity.ts, the studio's
// status-bar number), and the probes' own pick is kept unless another candidate
// is clearly closer. The candidates, their order and the winner rule are the
// studio's "Find best settings" (lib/traceInput/bestSettings.ts), run headless.

import { docStats, serializeDoc } from '../lib/path/model.ts'
import { defaultInset, normalizeDoc, type NormalizeSpec } from '../lib/path/normalize.ts'
import { deltaEField, deltaEStats, SCORE_MAX_DIM } from '../lib/render/fidelity.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { downscaleImageData } from '../lib/sheet/crop.ts'
import { estimateBackground } from '../lib/sheet/detect.ts'
import {
  planTileTrace,
  repaintDoc,
  tileTraceInput,
  traceTile,
  type TilePlan,
  type TileTrace,
} from '../lib/sheet/traceTile.ts'
import { CANDIDATE_LABELS, pickWinner, type CandidateId, type CandidateScore } from '../lib/traceInput/bestSettings.ts'
import { rasterCapFor } from '../lib/traceInput/traceCaps.ts'
import { PRODUCT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { EditableDoc } from '../lib/path/types'
import type { ImageDataLike } from '../lib/sheet/types'
import type { VectorizeOptions } from '../types'
import { hasAlpha, rasterizeSource, type LoadedSource } from './image.ts'
import { seeThroughAreas, type SeeThroughArea } from './logoProbe.ts'

/** Long side of the raster the planner probes before it knows the trace cap. */
const PLAN_PROBE_PX = 512

/**
 * Coordinate precision of a NORMALIZED SVG. On a 24-unit grid two decimals is
 * 1/2400 of the icon — what hand-authored icon sets ship with — where the
 * crop-sized viewBox of a plain trace keeps the studio's three.
 */
export const NORMALIZED_PRECISION = 2

/** The paint an `ink` request may name: a hex colour, or CSS's currentColor. */
export const INK_PAINT = /^(?:currentColor|#(?:[0-9a-f]{3}|[0-9a-f]{6}))$/i

/** What the caller asked for. Every field is optional — the defaults are the studio's. */
export interface TraceRequest {
  /** 'auto' counts the inks: one ink on paper traces mono (far cleaner), anything else colour. */
  mode?: 'auto' | 'color' | 'mono'
  /** Mono only: trace the ink as centreline STROKES with a measured width (line art), not filled outlines. */
  strokes?: boolean
  /** With `strokes`: no filled paths — dots and solid marks are drawn as strokes too. */
  strokesOnly?: boolean
  /** 'auto' probes for real colour ramps; 'flat' forces solid fills; 'rich' forces gradient fitting. */
  gradients?: 'auto' | 'flat' | 'rich'
  /** Colour only: 'stacked' (default) paints a shape under the shapes in front of it; 'tiled' cuts holes. */
  layering?: 'tiled' | 'stacked'
  /** Composite a transparent source onto this colour before tracing (e.g. '#ffffff'). */
  background?: string | null
  /** Drop the detected background layer, so the SVG comes back transparent. */
  removeBackground?: boolean
  /** 'high' lifts the flat-art raster cap 2048 → 4096: crisper, ~4× the work. */
  detail?: 'balanced' | 'high'
  /** 0 (crisp, node-dense) → 100 (smooth, sparse). Default 50. */
  smoothing?: number
  /** 0 (keep every speck) → 100 (aggressive). Default 25. */
  despeckle?: number
  /** Shape-beautification tolerance in px (0 disables snapping to circles/lines). */
  fidelity?: number
  /** Colour-mode segmentation detail 0–100; higher keeps subtler regions. */
  regionDetail?: number
  /**
   * Paint a MONO trace in this instead of the ink the probe read: a hex colour, or
   * `currentColor` so the icon takes the CSS text colour. Colour traces keep their
   * colours.
   */
  ink?: string
  /** Refit the result into a `size`×`size` viewBox, the art centred inside `inset`. */
  normalize?: NormalizeSpec | null
  /**
   * Trace every way the request leaves open (mode and gradients on auto), score
   * each against the source with the shipped ΔE, and keep the probes' pick unless
   * another candidate beats it by more than `searchMargin`. A forced `mode` or
   * `gradients` is kept. Default `SEARCH_BY_DEFAULT`.
   */
  search?: boolean
}

/**
 * Whether `traceIcon` searches when the request does not say. The one switch:
 * every caller that leaves `search` unset (the MCP tools, `logolab try`, the
 * benchmark's logolab-auto row) follows it. On: an agent does not look at the
 * trace, so a wrong mono call goes unnoticed, and a few seconds more cost it
 * little. Measured on the benchmark's fill corpora: mean rank 3.64 → 3.60 on
 * logos-cc0, 4.07 → 3.94 on svgemoji-v0, at about 2.5× the time.
 */
export const SEARCH_BY_DEFAULT = true

/** The `normalize` a tool call asked for: a box size, with the grid's usual inset unless given. */
export function normalizeSpecFrom(size: unknown, inset: unknown): NormalizeSpec | null {
  if (typeof size !== 'number' || !(size > 0)) return null
  return { size, inset: typeof inset === 'number' ? inset : defaultInset(size) }
}

/**
 * The SVG and its stats, refitted when asked. The trace itself is already
 * serialized at the studio's precision; a normalized doc is re-serialized at the
 * grid's, and the stats describe the document that was written.
 */
export function finishTrace(traced: TileTrace, normalize: NormalizeSpec | null | undefined): TileTrace {
  if (!normalize) return traced
  const doc: EditableDoc = normalizeDoc(traced.doc, normalize)
  return { doc, svg: serializeDoc(doc, NORMALIZED_PRECISION), stats: docStats(doc) }
}

/** The decisions, reported so the agent can see why it got this SVG. */
export interface TracePlanReport {
  mode: 'color' | 'mono'
  gradients: boolean
  /** Mono cut (0–255) and whether it was inverted for light-on-dark art. */
  threshold: number
  invert: boolean
  smoothing: number
  /** Distinct inks the probe counted — the number that picked mono vs colour. */
  inks: number
  /** The ink was traced as centreline strokes (mono + `strokes`). */
  strokes: boolean
  /** Enlargement applied before tracing (mono only; sub-pixel edges from AA). */
  upscale: number
  /**
   * The thin ink's thickness in traced px before enlargement (mono only; null
   * when not measured) — the stroke weight of the art, whether or not it was
   * traced as strokes.
   */
  inkThickness: number | null
  /** The paint a mono trace is written in (the probed ink, or the `ink` asked for); null in colour. */
  ink: string | null
  /** Long-side cap the source was rasterized to. */
  rasterCap: number
  /** Pixels the tracer actually saw. */
  traced: { width: number; height: number }
  /** The viewBox the SVG was refitted to, when `normalize` was asked for. */
  normalized: NormalizeSpec | null
  /** What the search traced and why it kept this one; null when there was no search. */
  search: SearchReport | null
  /** One sentence an agent can relay to a human. */
  summary: string
}

/** The search's scoreboard: every candidate it traced, the winner first. */
export interface SearchReport {
  /** Long side (px) of the raster the candidates were traced and scored at. */
  size: number
  /** What the probes alone would have traced: the plain `traceIcon` result. */
  probed: CandidateId
  winner: CandidateId
  /** Winner first, then the rest by ΔE. */
  candidates: { id: CandidateId; label: string; meanDeltaE: number; nodes: number; ms: number }[]
  /** Why this one: the probes' pick overruled, or kept although another scored closer; null otherwise. */
  note: string | null
}

export interface TraceOutcome {
  svg: string
  plan: TracePlanReport
  stats: { paths: number; nodes: number; colors: number }
  ms: number
}

/** Merge the request onto the studio's defaults. */
export function baseOptions(req: TraceRequest): VectorizeOptions {
  const base: VectorizeOptions = { ...PRODUCT_VECTORIZE_OPTIONS }
  if (req.smoothing != null) base.smoothing = clamp(req.smoothing, 0, 100)
  if (req.despeckle != null) base.despeckle = clamp(req.despeckle, 0, 100)
  if (req.fidelity != null) base.fidelity = Math.max(0, req.fidelity)
  if (req.regionDetail != null) base.regionDetail = clamp(req.regionDetail, 0, 100)
  if (req.removeBackground != null) base.removeBackground = req.removeBackground
  if (req.detail) base.traceDetail = req.detail
  if (req.strokes) base.centerline = true
  if (req.strokes && req.strokesOnly) base.strokesOnly = true
  if (req.layering) base.layering = req.layering
  return withGradientMode(base, req.gradients)
}

/**
 * A forced gradient mode, written into the options the way the sheet tab's
 * control does (`setGradientMode`): 'flat' off, 'rich' on. The planner reads its
 * `gradientMode` only to decide whether to PROBE ('auto'); for the other two it
 * keeps `opts.gradients` as given, so without this the defaults (gradients on)
 * won and 'flat' traced with ramps, at the gradient raster cap.
 */
export function withGradientMode(opts: VectorizeOptions, mode: TraceRequest['gradients']): VectorizeOptions {
  return !mode || mode === 'auto' ? opts : { ...opts, gradients: mode === 'rich' }
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * Plan a trace without running it: what the tracer would decide, and why. Cheap
 * (one 512px raster), so `inspect_icon` can answer instantly.
 */
export async function planTrace(
  src: LoadedSource,
  req: TraceRequest = {},
  maxDim = Number.POSITIVE_INFINITY,
): Promise<{
  plan: TracePlanReport
  opts: VectorizeOptions
  pixels: ImageDataLike
  recolor: string | null
  /** The ink the probe read (mono only): what a mono trace is SCORED in, whatever `ink` paints it. */
  probedInk: string | null
}> {
  const base = baseOptions(req)
  const background = req.background ?? undefined
  const probe = await rasterizeSource(src, PLAN_PROBE_PX, background)
  const bg = estimateBackground(probe, 24)

  // Two planner passes: the first only learns mode + gradients, which decide the
  // raster cap; the caller then re-plans on the capped pixels, so the mono cut
  // and smoothing scale are measured on what the tracer will really see.
  const first = planTileTrace(probe, base, {
    colorMode: req.mode ?? 'auto',
    gradientMode: req.gradients ?? 'auto',
    background: bg,
  })
  // `maxDim` caps it further: the search traces its candidates on a reduced copy.
  const rasterCap = Math.min(rasterCapFor(first.opts), maxDim)

  const pixels = await rasterizeSource(src, rasterCap, background)
  const plan = planTileTrace(pixels, base, {
    colorMode: req.mode ?? 'auto',
    gradientMode: req.gradients ?? 'auto',
    background: estimateBackground(pixels, 24),
  })

  const opts = plan.opts
  const scaled =
    plan.scale > 1
      ? { width: pixels.width * plan.scale, height: pixels.height * plan.scale }
      : { width: pixels.width, height: pixels.height }
  // `recolor` rides along: a mono trace comes back black, and the plan is the only
  // thing that knows the ink's real colour — unless the caller named the paint.
  const recolor = opts.mode === 'mono' ? (inkPaint(req.ink) ?? plan.recolor) : null
  const normalized = req.normalize ?? null
  const report: TracePlanReport = {
    mode: opts.mode,
    gradients: opts.gradients !== false,
    threshold: opts.threshold,
    invert: opts.invert === true,
    smoothing: opts.smoothing,
    inks: plan.inks,
    strokes: opts.centerline === true,
    upscale: plan.scale,
    inkThickness: plan.thickness,
    ink: recolor,
    rasterCap,
    traced: scaled,
    normalized,
    search: null,
    summary: summarize(src, plan.inks, plan.colourBecause, opts, plan.scale, scaled, recolor, normalized),
  }
  return { plan: report, opts, pixels, recolor, probedInk: opts.mode === 'mono' ? plan.recolor : null }
}

/** A requested ink, validated: hex colours are lower-cased, `currentColor` kept as CSS spells it. */
export function inkPaint(ink: string | undefined): string | null {
  if (ink == null) return null
  const v = ink.trim()
  if (!INK_PAINT.test(v)) {
    throw new Error(`ink must be a hex colour like #1f2937 or "currentColor", not "${ink}".`)
  }
  return v.toLowerCase() === 'currentcolor' ? 'currentColor' : v.toLowerCase()
}

function summarize(
  src: LoadedSource,
  inks: number,
  colourBecause: TilePlan['colourBecause'],
  opts: VectorizeOptions,
  scale: number,
  traced: { width: number; height: number },
  ink: string | null,
  normalized: NormalizeSpec | null,
): string {
  const bits: string[] = []
  bits.push(
    opts.mode === 'mono'
      ? `mono (${inksPhrase(inks)} on paper${opts.invert ? ', light-on-dark so the cut is inverted' : ''}, cut at ${opts.threshold}${opts.centerline ? ', traced as centreline strokes with a measured width' : ''}${ink ? `, painted ${ink}` : ''})`
      : opts.centerline
        ? `colour (${colourWhy(inks, colourBecause)})${req_strokes_note(opts)}`
        : `colour (${colourWhy(inks, colourBecause)}), gradients ${opts.gradients === false ? 'off — flat fills' : 'on — real SVG ramps'}`,
  )
  bits.push(
    `traced at ${traced.width}×${traced.height}${scale > 1 ? ` (source enlarged ×${scale} for sub-pixel edges)` : ''}`,
  )
  if (normalized) bits.push(`fitted to a ${normalized.size}×${normalized.size} viewBox, inset ${normalized.inset}`)
  if (src.kind === 'svg') bits.push('source is already vector — it was rasterized and re-traced')
  return bits.join('; ')
}

const inksPhrase = (inks: number): string => (inks === 1 ? 'one ink' : `${inks} inks`)

/** What the colour summary says the probe saw: the ink count, and why one ink is still colour. */
function colourWhy(inks: number, because: TilePlan['colourBecause']): string {
  if (because === 'ramps') return 'one ink, but it holds gradients one flat ink would lose'
  if (because === 'third-colour') return 'one ink, plus a third colour that ink and paper alone cannot paint'
  return inksPhrase(inks)
}

/** Colour line art traced as strokes: the lines come back in their own inks. */
function req_strokes_note(opts: VectorizeOptions): string {
  return opts.centerline ? ', traced as centreline strokes, each in the ink it runs through' : ''
}

/** Trace an image into an SVG string, reporting the plan it used. */
export async function traceIcon(src: LoadedSource, req: TraceRequest = {}): Promise<TraceOutcome> {
  const started = Date.now()
  const run = ((req.search ?? SEARCH_BY_DEFAULT) && (await searchTrace(src, req))) || (await planAndTrace(src, req))
  const traced = finishTrace(run.traced, req.normalize)
  return { svg: traced.svg, plan: run.plan, stats: traced.stats, ms: Date.now() - started }
}

export interface PlannedTrace {
  plan: TracePlanReport
  /** The trace before `normalize`. */
  traced: TileTrace
  /** The raster the plan was measured on (before the mono enlargement): what a search scores against. */
  pixels: ImageDataLike
  probedInk: string | null
}

/** Plan, then trace: the whole of a plain `traceIcon`, with the raster capped at `maxDim`. */
async function planAndTrace(src: LoadedSource, req: TraceRequest, maxDim?: number): Promise<PlannedTrace> {
  const { plan, opts, pixels, recolor, probedInk } = await planTrace(src, req, maxDim)
  // A mono trace comes back black; repaint it with the ink the probe found (the
  // same recolour the sheet batch applies).
  const input = tileTraceInput(pixels, plan.upscale)
  const traced = await traceTile(input, opts, undefined, undefined, recolor)
  return { plan, traced, pixels, probedInk }
}

/* ------------------------------------------------------------------ search */

/**
 * Long side the search traces its candidates at, before it traces the winner
 * again at the production raster; null traces every candidate at the production
 * raster and keeps the winner as traced. Null, measured on the benchmark's fill
 * corpora: at the studio's `SEARCH_MAX_DIM` (352) the pick matched the
 * production-raster pick on 80% of logos-cc0 and 88% of svgemoji-v0, turned the
 * logos mean rank worse than no search, and saved only a third of the time.
 */
export const SEARCH_SIZE: number | null = null

/**
 * How much closer than the probes' pick another candidate must score to replace
 * it; among the rest, a simpler candidate within it of the closest wins.
 * Relative, because a trace's mean ΔE over a mostly-blank icon is small: the
 * plain probe's inverted mono on svgemoji 1f4f3 scores 0.186 against colour's
 * 0.033, a five-fold error that an absolute margin like the studio's 0.3 ΔE
 * would call a tie. The floor keeps two near-perfect traces (0.004 vs 0.002)
 * from trading places on noise.
 */
export function searchMargin(bestDeltaE: number): number {
  return SEARCH_MARGIN_ABS + SEARCH_MARGIN_REL * bestDeltaE
}
export const SEARCH_MARGIN_ABS = 0.005
export const SEARCH_MARGIN_REL = 0.2

/**
 * Mono is a candidate only when the ink probe counted at most this many inks (or
 * picked mono itself): one ink repainted cannot draw two. Measured: forced mono
 * on two-or-more-ink art never came within the margin and never won.
 */
export const SEARCH_MONO_MAX_INKS = 1

/** What each candidate pins on the request; everything else the caller asked for rides along. */
export const SEARCH_CANDIDATES: Partial<Record<CandidateId, Pick<TraceRequest, 'mode' | 'gradients'>>> = {
  strokes: { mode: 'mono' },
  mono: { mode: 'mono' },
  flat: { mode: 'color', gradients: 'flat' },
  gradients: { mode: 'color', gradients: 'rich' },
}

/** The candidate a plan IS: what the probes picked, in the search's terms. */
export function candidateOf(plan: Pick<TracePlanReport, 'mode' | 'gradients' | 'strokes'>): CandidateId {
  if (plan.mode === 'mono') return plan.strokes ? 'strokes' : 'mono'
  return plan.gradients && !plan.strokes ? 'gradients' : 'flat'
}

/**
 * The candidates a request leaves open, simplest first: mono (as strokes when
 * `strokes` was asked for) unless colour was, then colour flat and with gradients
 * unless `gradients` was forced. Colour strokes paint flat inks, so a strokes
 * request has one colour candidate. With the probes' plan, mono stays only on
 * art with at most `SEARCH_MONO_MAX_INKS` inks, or when the probes picked it.
 */
export function searchCandidates(req: TraceRequest, probed?: { inks: number; pick: CandidateId }): CandidateId[] {
  const out: CandidateId[] = []
  const mono: CandidateId = req.strokes ? 'strokes' : 'mono'
  const monoFits = !probed || probed.inks <= SEARCH_MONO_MAX_INKS || probed.pick === mono
  if (req.mode !== 'color' && monoFits) out.push(mono)
  if (req.mode !== 'mono') {
    if (req.strokes || req.gradients !== 'rich') out.push('flat')
    if (!req.strokes && req.gradients !== 'flat') out.push('gradients')
  }
  return out
}

export interface CandidateRun extends CandidateScore {
  /** Plan + trace + score, ms. */
  ms: number
  run: PlannedTrace
}

/**
 * Trace one candidate (the request with the candidate's mode and gradients
 * pinned, so exactly what `traceIcon` returns for that request) at `maxDim`, and
 * score it against the raster it was traced from. A mono trace is scored in the
 * ink the probe read, not in an `ink` the caller asked to paint it.
 */
export async function runCandidate(
  src: LoadedSource,
  req: TraceRequest,
  id: CandidateId,
  maxDim?: number,
): Promise<CandidateRun> {
  const t0 = Date.now()
  const run = await planAndTrace(src, { ...req, ...SEARCH_CANDIDATES[id], search: false }, maxDim)
  const doc = run.probedInk ? repaintDoc(run.traced.doc, run.probedInk) : run.traced.doc
  const source = downscaleImageData(run.pixels, SCORE_MAX_DIM)
  const vbW = doc.viewBox[2]
  const render = rasterizeDoc(doc, source.width, source.height, { scale: vbW > 0 ? source.width / vbW : 1 })
  const { meanDeltaE } = deltaEStats(deltaEField(source.data, render, source.width, source.height).de)
  return { id, meanDeltaE, nodes: run.traced.stats.nodes, ms: Date.now() - t0, run }
}

/**
 * Rank the runs: the probes' pick while it is within `searchMargin` of the
 * closest ΔE; otherwise the closest, unless a simpler one is within the margin.
 */
export function pickSearchWinner(scores: readonly CandidateScore[], probed?: CandidateId): CandidateScore[] {
  const finite = scores.filter((s) => Number.isFinite(s.meanDeltaE)).map((s) => s.meanDeltaE)
  return finite.length ? pickWinner(scores, searchMargin(Math.min(...finite)), probed) : []
}

/**
 * The search: every open candidate traced and scored, the winner traced at the
 * production raster (or kept, when the search ran there). Null when the request
 * leaves nothing to choose, or no candidate traced.
 */
async function searchTrace(src: LoadedSource, req: TraceRequest): Promise<PlannedTrace | null> {
  if (searchCandidates(req).length < 2) return null
  // The probes' plan: the incumbent, and the ink count that decides whether mono is worth a trace.
  const { plan } = await planTrace(src, req)
  const probed = candidateOf(plan)
  const ids = searchCandidates(req, { inks: plan.inks, pick: probed })
  if (ids.length < 2) return null
  const size = SEARCH_SIZE
  const runs: CandidateRun[] = []
  for (const id of ids) {
    try {
      runs.push(await runCandidate(src, req, id, size ?? undefined))
    } catch {
      // One candidate failing drops that candidate, not the trace.
    }
  }
  const ranked = pickSearchWinner(runs, probed)
  if (!ranked.length) return null
  const winner = runs.find((r) => r.id === ranked[0].id) as CandidateRun
  const final =
    size == null ? winner.run : await planAndTrace(src, { ...req, ...SEARCH_CANDIDATES[winner.id], search: false })
  const report: SearchReport = {
    size: Math.max(winner.run.pixels.width, winner.run.pixels.height),
    probed,
    winner: winner.id,
    candidates: ranked.map((s) => {
      const r = runs.find((x) => x.id === s.id) as CandidateRun
      return { id: r.id, label: CANDIDATE_LABELS[r.id], meanDeltaE: r.meanDeltaE, nodes: r.nodes, ms: r.ms }
    }),
    note: searchNote(ranked, probed),
  }
  return {
    ...final,
    plan: { ...final.plan, search: report, summary: `${final.plan.summary}; ${searchSummary(report)}` },
  }
}

/** Why this winner: the probes overruled, or kept (or a simpler one picked) although another scored closer. */
function searchNote(ranked: readonly CandidateScore[], probed: CandidateId): string | null {
  const [winner, ...rest] = ranked
  const label = (id: CandidateId) => CANDIDATE_LABELS[id]
  if (winner.id !== probed) return `the probes picked ${label(probed)}; ${label(winner.id)} is clearly closer`
  const closest = rest.reduce((m, s) => (s.meanDeltaE < m.meanDeltaE ? s : m), winner)
  if (closest === winner || closest.meanDeltaE >= winner.meanDeltaE) return null
  return `the probes' pick is within the margin of ${label(closest.id)}, so it stays`
}

/** The summary's search clause: what won, and every candidate's ΔE. */
function searchSummary(r: SearchReport): string {
  const scores = r.candidates.map((c) => `${c.id} ${c.meanDeltaE.toFixed(3)}`).join(', ')
  return `searched ${r.candidates.length} candidates by ΔE at ${r.size}px, ${r.winner} won (${scores})${r.note ? `: ${r.note}` : ''}`
}

/** Report on the source itself — what an agent should know before it traces. */
export async function describeSource(src: LoadedSource): Promise<{
  path: string
  kind: 'svg' | 'raster'
  mime: string
  width: number
  height: number
  transparent: boolean
  /** Transparent areas the art encloses (see logoProbe.ts) — they show what is behind the icon. */
  seeThrough: SeeThroughArea[]
}> {
  const probe = await rasterizeSource(src, Math.min(256, Math.max(src.width, src.height)))
  const transparent = hasAlpha(probe)
  return {
    path: src.path,
    kind: src.kind,
    mime: src.mime,
    width: src.width,
    height: src.height,
    transparent,
    seeThrough: transparent ? seeThroughAreas(probe) : [],
  }
}

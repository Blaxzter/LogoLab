// Auto-trace: an image an agent just generated → a clean SVG, with the decisions
// made for it.
//
// Everything here is the app's own pipeline, headless. The decisions the studio
// makes for a human — colour vs mono, where a mono cut falls, whether the art has
// real gradients, what resolution to trace at — are `planTileTrace` (src/lib/sheet),
// and the trace itself is `traceTile`, the same function the icon-sheet batch and
// the single-icon editor run. The plan is reported back so an agent can
// overrule one decision without hand-tuning the rest.

import { docStats, serializeDoc } from '../lib/path/model.ts'
import { defaultInset, normalizeDoc, type NormalizeSpec } from '../lib/path/normalize.ts'
import { estimateBackground } from '../lib/sheet/detect.ts'
import { planTileTrace, tileTraceInput, traceTile, type TileTrace } from '../lib/sheet/traceTile.ts'
import { rasterCapFor } from '../lib/traceInput/traceCaps.ts'
import { PRODUCT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { EditableDoc } from '../lib/path/types'
import type { ImageDataLike } from '../lib/sheet/types'
import type { VectorizeOptions } from '../types'
import { hasAlpha, rasterizeSource, type LoadedSource } from './image.ts'

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
}

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
  /** One sentence an agent can relay to a human. */
  summary: string
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
): Promise<{ plan: TracePlanReport; opts: VectorizeOptions; pixels: ImageDataLike; recolor: string | null }> {
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
  const rasterCap = rasterCapFor(first.opts)

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
    summary: summarize(src, plan.inks, opts, plan.scale, scaled, recolor, normalized),
  }
  return { plan: report, opts, pixels, recolor }
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
  opts: VectorizeOptions,
  scale: number,
  traced: { width: number; height: number },
  ink: string | null,
  normalized: NormalizeSpec | null,
): string {
  const bits: string[] = []
  bits.push(
    opts.mode === 'mono'
      ? `mono (${inks === 1 ? 'one ink' : `${inks} inks`} on paper${opts.invert ? ', light-on-dark so the cut is inverted' : ''}, cut at ${opts.threshold}${opts.centerline ? ', traced as centreline strokes with a measured width' : ''}${ink ? `, painted ${ink}` : ''})`
      : opts.centerline
        ? `colour (${inks} inks)${req_strokes_note(opts)}`
        : `colour (${inks} inks), gradients ${opts.gradients === false ? 'off — flat fills' : 'on — real SVG ramps'}`,
  )
  bits.push(
    `traced at ${traced.width}×${traced.height}${scale > 1 ? ` (source enlarged ×${scale} for sub-pixel edges)` : ''}`,
  )
  if (normalized) bits.push(`fitted to a ${normalized.size}×${normalized.size} viewBox, inset ${normalized.inset}`)
  if (src.kind === 'svg') bits.push('source is already vector — it was rasterized and re-traced')
  return bits.join('; ')
}

/** Colour line art traced as strokes: the lines come back in their own inks. */
function req_strokes_note(opts: VectorizeOptions): string {
  return opts.centerline ? ', traced as centreline strokes, each in the ink it runs through' : ''
}

/** Trace an image into an SVG string, reporting the plan it used. */
export async function traceIcon(src: LoadedSource, req: TraceRequest = {}): Promise<TraceOutcome> {
  const started = Date.now()
  const { plan, opts, pixels, recolor } = await planTrace(src, req)

  // A mono trace comes back black; repaint it with the ink the probe found (the
  // same recolour the sheet batch applies).
  const input = tileTraceInput(pixels, plan.upscale)
  const traced = finishTrace(await traceTile(input, opts, undefined, undefined, recolor), req.normalize)

  return { svg: traced.svg, plan, stats: traced.stats, ms: Date.now() - started }
}

/** Report on the source itself — what an agent should know before it traces. */
export async function describeSource(src: LoadedSource): Promise<{
  path: string
  kind: 'svg' | 'raster'
  mime: string
  width: number
  height: number
  transparent: boolean
}> {
  const probe = await rasterizeSource(src, Math.min(256, Math.max(src.width, src.height)))
  return {
    path: src.path,
    kind: src.kind,
    mime: src.mime,
    width: src.width,
    height: src.height,
    transparent: hasAlpha(probe),
  }
}

// Auto-trace: an image an agent just generated → a clean SVG, with the decisions
// made for it.
//
// Everything here is the app's own pipeline, headless. The decisions the studio
// makes for a human — colour vs mono, where a mono cut falls, whether the art has
// real gradients, what resolution to trace at — are `planTileTrace` (src/lib/sheet),
// and the trace itself is `traceTile`, the same function the icon-sheet batch and
// the single-icon editor run. An agent gets the same answer a person would, and
// the plan is REPORTED back so it can overrule one decision without hand-tuning
// the rest.

import { estimateBackground } from '../lib/sheet/detect.ts'
import { planTileTrace, tileTraceInput, traceTile } from '../lib/sheet/traceTile.ts'
import { rasterCapFor } from '../lib/traceCaps.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { ImageDataLike } from '../lib/sheet/types'
import type { VectorizeOptions } from '../types'
import { hasAlpha, rasterizeSource, type LoadedSource } from './image.ts'

/** Long side of the raster the planner probes before it knows the trace cap. */
const PLAN_PROBE_PX = 512

/** What the caller asked for. Every field is optional — the defaults are the studio's. */
export interface TraceRequest {
  /** 'auto' counts the inks: one ink on paper traces mono (far cleaner), anything else colour. */
  mode?: 'auto' | 'color' | 'mono'
  /** 'auto' probes for real colour ramps; 'flat' forces solid fills; 'rich' forces gradient fitting. */
  gradients?: 'auto' | 'flat' | 'rich'
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
}

/** The decisions, reported so the agent can see WHY it got this SVG. */
export interface TracePlanReport {
  mode: 'color' | 'mono'
  gradients: boolean
  /** Mono cut (0–255) and whether it was inverted for light-on-dark art. */
  threshold: number
  invert: boolean
  smoothing: number
  /** Distinct inks the probe counted — the number that picked mono vs colour. */
  inks: number
  /** Enlargement applied before tracing (mono only; sub-pixel edges from AA). */
  upscale: number
  /** Long-side cap the source was rasterized to. */
  rasterCap: number
  /** Pixels the tracer actually saw. */
  traced: { width: number; height: number }
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
function baseOptions(req: TraceRequest): VectorizeOptions {
  const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS }
  if (req.smoothing != null) base.smoothing = clamp(req.smoothing, 0, 100)
  if (req.despeckle != null) base.despeckle = clamp(req.despeckle, 0, 100)
  if (req.fidelity != null) base.fidelity = Math.max(0, req.fidelity)
  if (req.regionDetail != null) base.regionDetail = clamp(req.regionDetail, 0, 100)
  if (req.removeBackground != null) base.removeBackground = req.removeBackground
  if (req.detail) base.traceDetail = req.detail
  return base
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

  // Two passes over the planner: the first is only to learn mode + gradients, which
  // together decide the raster cap (flat art traces at 2048, gradient art at 1024);
  // the caller then re-plans on the pixels that cap produces, where the mono cut and
  // the smoothing scale are measured on what the tracer will really see.
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
  const scaled = plan.scale > 1 ? { width: pixels.width * plan.scale, height: pixels.height * plan.scale } : { width: pixels.width, height: pixels.height }
  const report: TracePlanReport = {
    mode: opts.mode,
    gradients: opts.gradients !== false,
    threshold: opts.threshold,
    invert: opts.invert === true,
    smoothing: opts.smoothing,
    inks: plan.inks,
    upscale: plan.scale,
    rasterCap,
    traced: scaled,
    summary: summarize(src, plan.inks, opts, plan.scale, scaled),
  }
  // `recolor` rides along: a mono trace comes back black, and the plan is the only
  // thing that knows the ink's real colour.
  return { plan: report, opts, pixels, recolor: plan.recolor }
}

function summarize(
  src: LoadedSource,
  inks: number,
  opts: VectorizeOptions,
  scale: number,
  traced: { width: number; height: number },
): string {
  const bits: string[] = []
  bits.push(
    opts.mode === 'mono'
      ? `mono (${inks === 1 ? 'one ink' : `${inks} inks`} on paper${opts.invert ? ', light-on-dark so the cut is inverted' : ''}, cut at ${opts.threshold})`
      : `colour (${inks} inks), gradients ${opts.gradients === false ? 'off — flat fills' : 'on — real SVG ramps'}`,
  )
  bits.push(`traced at ${traced.width}×${traced.height}${scale > 1 ? ` (source enlarged ×${scale} for sub-pixel edges)` : ''}`)
  if (src.kind === 'svg') bits.push('source is already vector — it was rasterized and re-traced')
  return bits.join('; ')
}

/** Trace an image into an SVG string, reporting the plan it used. */
export async function traceIcon(src: LoadedSource, req: TraceRequest = {}): Promise<TraceOutcome> {
  const started = Date.now()
  const { plan, opts, pixels, recolor } = await planTrace(src, req)

  // A mono trace comes back black; repaint it with the ink the probe found (the
  // same recolour the sheet batch applies).
  const input = tileTraceInput(pixels, plan.upscale)
  const traced = await traceTile(input, opts, undefined, undefined, recolor)

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

// Left rail of the vectorize studio: trace parameters in collapsible sections
// plus the pinned Trace button. Each knob has a hint and an (i) that opens
// ControlInfoDialog. Controlled UI: trace state lives in VectorizeStudio; only
// the open info dialog is local.

import { useState } from 'react'
import { WandSparkles, CircleHelp, AlertTriangle, MapPin, RotateCcw, X } from '../ui/icons'
import { ActionButton } from '../ui/ActionButton'
import { Button } from '../ui/Button'
import { ColorField, Collapsible, Field, Segmented, Slider, Toggle } from '../ui/controls'
import { Tooltip } from '../ui/Tooltip'
import type { VectorizeOptions } from '../../types'
import type { InkColorMode, InkModePlan } from '../../lib/traceInput/ink'
import { CONTROL_DOCS_BY_ID } from './controlDocs'
import { ControlInfoDialog } from './ControlInfoDialog'
import { BestSettings, type BestSettingsProps } from './BestSettings'
import { AI_UPSCALE_MAX_PX, aiUpscaleFactor } from '../../lib/traceInput/aiUpscale'
import {
  MONO_TARGET_STROKE_PX,
  RASTER_MAX_DIM,
  RASTER_MAX_DIM_FLAT,
  RASTER_MAX_DIM_HIGH,
  TRACE_TARGET_PX,
  rasterCapFor,
  type MonoUpscalePlan,
} from '../../lib/traceInput/traceCaps'

export interface TraceControlsProps {
  /** The upload is an SVG, so "clean existing markup" is an option. */
  isVectorSource: boolean
  source: 'clean' | 'retrace'
  onSourceChange: (v: 'clean' | 'retrace') => void
  opts: VectorizeOptions
  onPatch: (patch: Partial<VectorizeOptions>) => void
  /** Longest side of the source image (px), for the Detail preset's effect hint. */
  sourceMaxDim?: number
  /** What Auto enlargement decided on the last run (null before one, or on the AI path). */
  autoUpscale?: MonoUpscalePlan | null
  /** Colour-vs-mono choice: `auto` defers to the ink probe (src/lib/traceInput/ink.ts). */
  colorMode: InkColorMode
  onColorMode: (m: InkColorMode) => void
  /** What the ink probe last saw, so Auto can say what it decided and why. */
  inkPlan: InkModePlan | null
  /**
   * What the current mono cut admits, so Threshold and Invert can show which
   * settings would trace nothing before the user picks them. Null outside mono
   * or before the probe lands.
   */
  monoGuide: {
    /** Cuts at or below this select nothing with Invert off. */
    deadOff: number
    /** Cuts at or above this select nothing with Invert on. */
    deadOn: number
    /** Fraction of visible pixels each Invert position admits at this cut. */
    fracOff: number
    fracOn: number
  } | null
  forceColorOn: boolean
  onForceColorOn: (v: boolean) => void
  forceColor: string
  onForceColor: (v: string) => void
  /** Region-marker (segmentation seed) state, lifted from VectorizeStudio. */
  marking: boolean
  onMarkingChange: (on: boolean) => void
  markerCount: number
  /** How many of the markers are tagged "flat". */
  flatCount: number
  /** How many of the markers are tagged "remove". */
  removeCount: number
  /** Which kind of marker a click drops. */
  markMode: 'separate' | 'flat' | 'remove'
  onMarkModeChange: (m: 'separate' | 'flat' | 'remove') => void
  onClearMarkers: () => void
  busy: boolean
  /** Params changed while the doc carries manual edits — re-trace discards them. */
  staleEdits: boolean
  /** A trace was Stopped, so the shown result lags the current settings (no edits at risk). */
  staleOpts?: boolean
  onTrace: () => void
  /** Open the "How it works" pipeline explainer. */
  onShowHelp: () => void
  /** False when the settings already match what a fresh upload of this image gets. */
  canReset: boolean
  /** Restore the settings a fresh upload of this image gets (markers stay). */
  onReset: () => void
  /** "Find best settings": trace a few candidates, score them, apply the winner. */
  best: BestSettingsProps
}

const d = CONTROL_DOCS_BY_ID

/** A fraction as a percentage, keeping one decimal for small values: "0.4%" is a
 *  hairline that still traces, and "0%" would misreport it. */
function pct(f: number): string {
  if (f === 0) return '0%'
  if (f < 0.01) return `${(f * 100).toFixed(1)}%`
  return `${Math.round(f * 100)}%`
}

/** Desktop rail — the 320px column. Below lg it's hidden; the same body renders
 *  inside the studio's "Trace" bottom sheet instead (see VectorizeStudio). */
export function TraceControls(props: TraceControlsProps) {
  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-r border-line bg-surface lg:flex">
      <TraceControlsBody {...props} />
    </aside>
  )
}

export function TraceControlsBody({
  isVectorSource,
  source,
  onSourceChange,
  opts,
  onPatch,
  sourceMaxDim,
  autoUpscale,
  colorMode,
  onColorMode,
  inkPlan,
  monoGuide,
  forceColorOn,
  onForceColorOn,
  forceColor,
  onForceColor,
  marking,
  onMarkingChange,
  markerCount,
  flatCount,
  removeCount,
  markMode,
  onMarkModeChange,
  onClearMarkers,
  busy,
  staleEdits,
  staleOpts = false,
  onTrace,
  onShowHelp,
  canReset,
  onReset,
  best,
}: TraceControlsProps) {
  const tracing = !isVectorSource || source === 'retrace'
  const [infoId, setInfoId] = useState<string | null>(null)
  const info = (id: string) => () => setInfoId(id)

  const detailSummary = tracing
    ? opts.mode === 'mono'
      ? `Mono · threshold ${opts.threshold}${opts.invert ? ' · inverted' : ''}${opts.centerline ? ' · strokes' : ''}`
      : `Smoothing ${opts.smoothing}${opts.centerline ? ' · strokes' : ''}`
    : 'Cleaning SVG markup'
  // Force colour repaints every shape; a collapsed "Flat fills" hid where the colours went.
  const colorSummary = forceColorOn
    ? `All shapes ${forceColor}`
    : opts.mode === 'color' && opts.gradients !== false && !opts.centerline
      ? 'Gradients on'
      : 'Flat fills'

  // Controls that have no effect on this image fold into one collapsed list that
  // names each and says why, rather than silently doing nothing or vanishing.
  // An inert control that is not at its default (e.g. `upscale: 'ai'` carried over
  // from a smaller image) stays in place so the setting can still be undone.
  // The rules come from traceCaps.ts and aiUpscale.ts, so the reasons match what
  // the pipeline does.
  const flatArt = opts.mode === 'mono' || opts.gradients === false || opts.centerline === true
  const detailWhy = !flatArt
    ? `High only raises the size limit for flat art. Gradient and photo colour stays at ${RASTER_MAX_DIM}px so merging regions doesn't get bogged down. Turn Gradients off or switch to Mono to use it.`
    : sourceMaxDim != null && sourceMaxDim <= RASTER_MAX_DIM_FLAT
      ? `Your image is ${sourceMaxDim}px on its longest side, already within the ${RASTER_MAX_DIM_FLAT}px Balanced limit. Detail never enlarges an image, so High has no extra pixels to read.`
      : null
  const showDetail = detailWhy == null || (opts.traceDetail ?? 'balanced') !== 'balanced'

  // Auto enlarges mono art when the cap leaves room for a factor of 2; AI enlarges
  // small rasters in any mode. Upscale is inert only when neither applies.
  const cap = rasterCapFor(opts)
  const room = sourceMaxDim ? Math.floor(cap / sourceMaxDim) : 0
  const autoCanBite = opts.mode === 'mono' && room >= 2
  const aiCanBite = sourceMaxDim != null && aiUpscaleFactor(sourceMaxDim) > 0
  const upscaleWhy = isVectorSource
    ? 'An SVG is already rendered at full detail, so there is nothing to enlarge.'
    : sourceMaxDim == null || autoCanBite || aiCanBite
      ? null
      : opts.mode === 'mono'
        ? `Your image is ${sourceMaxDim}px on its longest side, more than half the ${cap}px limit, so there is no room to enlarge it.`
        : `Auto enlarges mono art only, and at ${sourceMaxDim}px your image is past the ${AI_UPSCALE_MAX_PX}px point where AI enlargement stops helping. Switch Mode to Mono to use Auto.`
  const upscaleMode = opts.upscale ?? 'auto'
  const showUpscale = upscaleWhy == null || upscaleMode !== 'auto'
  const upscaleHint = (() => {
    if (upscaleWhy) return upscaleWhy
    if (upscaleMode === 'off') return 'Traced at its own size, without enlarging.'
    if (upscaleMode === 'ai' && sourceMaxDim != null && !aiCanBite)
      return `AI only enlarges images up to ${AI_UPSCALE_MAX_PX}px. At ${sourceMaxDim}px it steps aside and Auto's rule applies${
        autoUpscale && autoUpscale.scale > 1
          ? ` (this image was enlarged ×${autoUpscale.scale} with plain bilinear scaling)`
          : ''
      }.`
    if (upscaleMode === 'ai')
      return `AI enlarges a small image ×${sourceMaxDim ? aiUpscaleFactor(sourceMaxDim) || 2 : '2–4'} before tracing (waifu2x, running in your browser: a one-time ~17–19 MB download, then a few seconds per trace). In our tests it gave cleaner corners and fewer nodes than tracing the image small.`
    if (opts.mode !== 'mono')
      return 'Auto enlarges mono art only, because colour tracing would pick up every blended in-between tone. For a small colour image, use AI.'
    if (!autoUpscale)
      return `Auto enlarges a mono image before tracing when it is small (toward ${TRACE_TARGET_PX}px) or its strokes are thin (toward ${MONO_TARGET_STROKE_PX}px). It uses plain bilinear scaling and never goes past the size limit.`
    if (autoUpscale.scale > 1)
      return autoUpscale.by === 'stroke'
        ? `Auto enlarged this image ×${autoUpscale.scale} before tracing: its thin strokes are ${autoUpscale.thickness}px, and the tracer works best at about ${MONO_TARGET_STROKE_PX}px.`
        : `Auto enlarged this image ×${autoUpscale.scale} before tracing: at ${sourceMaxDim}px it is small, and small images trace better enlarged toward ${TRACE_TARGET_PX}px.`
    if (autoUpscale.room < 2)
      return `Auto traced this image at its own size: at ${sourceMaxDim}px it is more than half the ${cap}px limit.`
    return `Auto traced this image at its own size: its strokes are ${autoUpscale.thickness ?? '—'}px, thick enough for the tracer.`
  })()

  const inert: { label: string; why: string }[] = []
  if (!tracing) {
    inert.push({
      label: 'Everything that traces pixels',
      why: 'Detail, Upscale, Smoothing, Despeckle, Fidelity, Region detail, Region markers and Gradients all work on pixels. Cleaning keeps the SVG’s own paths. Switch Source to Re-trace to rebuild them from pixels.',
    })
  } else {
    if (opts.mode === 'mono')
      inert.push({
        label: 'Region detail, Region markers, Gradients',
        why: 'Mono traces one ink against the background, so there are no colour regions to split, mark or fill with a gradient. Switch Mode to Color to use them.',
      })
    else {
      inert.push({
        label: 'Threshold, Invert',
        why: 'These set the Mono black/white cut: where it falls, and which side becomes solid. Switch Mode to Mono to use them.',
      })
      if (opts.centerline)
        inert.push({
          label: 'Gradients, Region markers',
          why: 'Strokes paints each line in one flat colour (the ink it runs through) and finds the inks from the palette alone. Turn Strokes off to use gradients or region markers.',
        })
    }
    if (detailWhy && !showDetail) inert.push({ label: 'Detail (Balanced / High)', why: detailWhy })
    if (upscaleWhy && !showUpscale) inert.push({ label: 'Upscale (Auto / AI)', why: upscaleWhy })
  }

  // The mono cut can yield nothing when all the ink sits on one side of it. Show
  // what both Invert positions admit and mark the dead cuts up front. The dead
  // span is drawn, not enforced: the estimate can be wrong on unusual art.
  const inverted = opts.invert === true
  const deadCuts = monoGuide
    ? inverted
      ? [{ from: monoGuide.deadOn, to: 255 }]
      : [{ from: 0, to: monoGuide.deadOff }]
    : undefined

  return (
    <>
      {/* Scrollable settings; the action below stays pinned. */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Vectorize</h2>
          <div className="flex items-center gap-1">
            <ActionButton
              label="Reset"
              reason={canReset ? null : 'These are already the settings this image starts with.'}
              note="Return to the starting settings for this image. Markers stay."
              onClick={onReset}
              className="btn btn-ghost h-7 gap-1 px-2 text-xs text-ink-2"
            >
              <RotateCcw size={14} />
              Reset
            </ActionButton>
            <Tooltip label="See how vectorize turns your image into shapes">
              <button type="button" onClick={onShowHelp} className="btn btn-ghost h-7 gap-1 px-2 text-xs text-ink-2">
                <CircleHelp size={14} />
                How it works
              </button>
            </Tooltip>
          </div>
        </div>

        <BestSettings {...best} />

        {isVectorSource && (
          <>
            <Field label="Source" hint="Re-trace turns the SVG into pixels, then traces new paths from them.">
              <Segmented<'clean' | 'retrace'>
                value={source}
                onChange={onSourceChange}
                options={[
                  { value: 'clean', label: 'Clean SVG' },
                  { value: 'retrace', label: 'Re-trace' },
                ]}
              />
            </Field>
            {!tracing && (
              <div className="rounded-md border border-accent-soft bg-accent-soft px-3 py-2 text-xs leading-snug text-ink-2">
                This is already a vector, so the existing SVG is cleaned up. Switch to Re-trace to rebuild the paths
                from pixels.
              </div>
            )}
          </>
        )}

        {tracing && (
          <Field label="Mode" hint={d.mode.hint} onInfo={info('mode')}>
            <Segmented<InkColorMode>
              value={colorMode}
              onChange={onColorMode}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'color', label: 'Color' },
                { value: 'mono', label: 'Mono' },
              ]}
            />
            {/* What Auto decided and why, so the user can overrule it. */}
            {colorMode === 'auto' && inkPlan && (
              <p className="text-xs leading-snug text-muted">
                {inkPlan.inks === 0
                  ? 'Found only background, so tracing in colour.'
                  : inkPlan.mode === 'mono'
                    ? `One ink${inkPlan.invert ? ', lighter than the background' : ''} → Mono, cut at ${inkPlan.threshold}${
                        inkPlan.hairlines && inkPlan.hairlines.cut !== inkPlan.hairlines.from
                          ? ` (raised from ${inkPlan.hairlines.from} to keep hairlines)`
                          : ''
                      }${inkPlan.invert ? ' and inverted' : ''}${inkPlan.recolor ? `, painted ${inkPlan.recolor}` : ''}.`
                    : inkPlan.inks === 1
                      ? // One ink, too close to the background in luminance
                        // for a cut (common for art on transparency).
                        'One ink, too close to the background to cut → Color.'
                      : `${inkPlan.inks} inks → Color.`}
              </p>
            )}
          </Field>
        )}

        {tracing && (
          <Collapsible title="Shape & detail" summary={detailSummary} defaultOpen>
            {showDetail && (
              <Field
                label="Detail"
                hint={
                  detailWhy ??
                  `High traces this image at up to ${RASTER_MAX_DIM_HIGH}px instead of ${RASTER_MAX_DIM_FLAT}px, for crisper edges at roughly 4× the trace time.`
                }
              >
                <Segmented<'balanced' | 'high'>
                  value={opts.traceDetail ?? 'balanced'}
                  onChange={(v) => onPatch({ traceDetail: v })}
                  options={[
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'high', label: 'High' },
                  ]}
                />
              </Field>
            )}

            {showUpscale && (
              <Field label="Upscale" hint={upscaleHint}>
                <Segmented<'off' | 'auto' | 'ai'>
                  value={upscaleMode}
                  onChange={(v) => onPatch({ upscale: v })}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'ai', label: 'AI' },
                  ]}
                />
              </Field>
            )}

            {opts.mode === 'mono' && (
              <>
                <Field label="Threshold" hint={d.threshold.hint} onInfo={info('threshold')}>
                  <Slider
                    value={opts.threshold}
                    min={0}
                    max={255}
                    onChange={(v) => onPatch({ threshold: v })}
                    dead={deadCuts}
                  />
                </Field>

                {/* Which side of the cut becomes solid. Light art on a dark ground
                      needs this, or it traces to nothing. */}
                <Field label="Invert" hint={d.invert.hint} onInfo={info('invert')}>
                  <Toggle
                    checked={opts.invert === true}
                    onChange={(v) => onPatch({ invert: v })}
                    label="Light ink on a dark background"
                  />
                  {/* What both positions admit, so an empty one is visible before
                        it is picked. */}
                  {monoGuide && (
                    <p className="text-xs leading-snug text-muted tabular-nums">
                      At this cut, Off keeps{' '}
                      <span className={opts.invert ? '' : 'font-semibold text-ink-2'}>{pct(monoGuide.fracOff)}</span> of
                      the visible pixels and On keeps{' '}
                      <span className={opts.invert ? 'font-semibold text-ink-2' : ''}>{pct(monoGuide.fracOn)}</span>.
                    </p>
                  )}
                </Field>
              </>
            )}

            {/* Line art: the centreline engine (src/lib/trace/centerline/) instead of
                  filled outlines — one ink in Mono, each line in its own ink in Colour
                  (centerline/colour.ts). The consequence is in the result itself — stroked
                  paths with a width — so the hint says what to expect, not what happened. */}
            <Field label="Strokes" hint={d.centerline.hint} onInfo={info('centerline')}>
              <Toggle
                checked={opts.centerline === true}
                onChange={(v) => onPatch({ centerline: v })}
                label="Trace lines as strokes with a width"
              />
            </Field>

            <Field label="Smoothing" hint={d.smoothing.hint} onInfo={info('smoothing')}>
              <Slider value={opts.smoothing} min={0} max={100} onChange={(v) => onPatch({ smoothing: v })} />
            </Field>

            <Field label="Despeckle" hint={d.despeckle.hint} onInfo={info('despeckle')}>
              <Slider value={opts.despeckle} min={0} max={100} onChange={(v) => onPatch({ despeckle: v })} />
            </Field>

            <Field label="Fidelity" hint={d.fidelity.hint} onInfo={info('fidelity')}>
              <Slider
                value={opts.fidelity ?? 1.5}
                min={0}
                max={6}
                step={0.5}
                onChange={(v) => onPatch({ fidelity: v })}
                format={(v) => (v === 0 ? 'off' : `${v}px`)}
              />
            </Field>

            {opts.mode === 'color' && (
              <Field label="Region detail" hint={d.regionDetail.hint} onInfo={info('regionDetail')}>
                <Slider
                  value={opts.regionDetail ?? 0}
                  min={0}
                  max={100}
                  step={5}
                  onChange={(v) => onPatch({ regionDetail: v })}
                  format={(v) => (v === 0 ? 'auto' : `${v}`)}
                />
              </Field>
            )}
          </Collapsible>
        )}

        {tracing && opts.mode === 'color' && (
          <Collapsible
            title="Region markers"
            summary={
              marking
                ? `Placing · ${markerCount} marker${markerCount === 1 ? '' : 's'}`
                : markerCount > 0
                  ? `${markerCount} marker${markerCount === 1 ? '' : 's'}`
                  : undefined
            }
          >
            {/* No master switch: with no markers placed the trace is unchanged. */}
            <p className="text-xs leading-snug text-muted">
              Mark a spot to keep its region <em>separate</em> from its neighbour, paint it one <em>flat</em> colour, or{' '}
              <em>remove</em> it and let the neighbours fill the gap. With no markers, the output is unchanged.
            </p>

            {/* Placement mode: click to seed (on) vs pan freely (off). */}
            <button
              type="button"
              aria-pressed={marking}
              onClick={() => onMarkingChange(!marking)}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                marking
                  ? 'border-emerald-400/70 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-line text-ink-2 hover:bg-surface-2'
              }`}
            >
              <MapPin size={14} />
              {marking ? 'Placing: click the image' : 'Place markers'}
            </button>
            <p className="text-xs leading-snug text-muted">
              {marking
                ? 'Click either pane to drop a marker; click a marker to remove it. Turn this off to pan and edit. Markers stay active.'
                : 'Markers stay active while you pan, zoom and edit. Turn on to place more.'}
            </p>

            {/* Marker kind a click drops: Separate keeps the region distinct,
                  Flat also pins it to one solid colour, Remove dissolves it into
                  its neighbours. */}
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-line p-1">
              {(
                [
                  ['separate', 'Separate', 'text-emerald-600 dark:text-emerald-400', '#10b981'],
                  ['flat', 'Flat', 'text-amber-600 dark:text-amber-400', '#f59e0b'],
                  ['remove', 'Remove', 'text-rose-600 dark:text-rose-400', '#f43f5e'],
                ] as const
              ).map(([mode, label, active, dot]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={markMode === mode}
                  onClick={() => onMarkModeChange(mode)}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                    markMode === mode ? `bg-surface-3 ${active}` : 'text-ink-2 hover:bg-surface-2'
                  }`}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: dot }} />
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs leading-snug text-muted">
              {markMode === 'flat'
                ? 'Flat: paints the section one solid colour. If it was fused with a different colour into a fake gradient, one marker splits it off along the colour edge.'
                : markMode === 'remove'
                  ? 'Remove: dissolves the clicked section and grows the colours around it into the gap until they meet in the middle, so no hole is left. Applies on the next trace.'
                  : 'Separate: keeps this region distinct and leaves its fitted paint (gradient or flat) as it is. If two regions merged that should not have, mark both sides to put the border on the colour edge.'}
            </p>

            {markerCount > 0 && (
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-ink-2">
                  <MapPin size={12} className="text-emerald-500" />
                  {markerCount} marker{markerCount === 1 ? '' : 's'}
                  {flatCount > 0 ? ` · ${flatCount} flat` : ''}
                  {removeCount > 0 ? ` · ${removeCount} remove` : ''}
                </span>
                <button
                  type="button"
                  onClick={onClearMarkers}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  <X size={12} /> Clear all
                </button>
              </div>
            )}
          </Collapsible>
        )}

        <Collapsible title="Color & background" summary={colorSummary}>
          {tracing && opts.mode === 'color' && !opts.centerline && (
            <Field label="Gradients" hint={d.gradients.hint} onInfo={info('gradients')}>
              <Toggle
                checked={opts.gradients !== false}
                onChange={(v) => onPatch({ gradients: v })}
                label="Fit smooth gradients"
              />
            </Field>
          )}

          <Field label="Remove background">
            <Toggle
              checked={opts.removeBackground}
              onChange={(v) => onPatch({ removeBackground: v })}
              label="Drop the main background"
            />
          </Field>

          <Field label="Force single color" right={<Toggle checked={forceColorOn} onChange={onForceColorOn} />}>
            {forceColorOn ? (
              <ColorField value={forceColor} onChange={onForceColor} />
            ) : (
              <p className="text-xs leading-snug text-muted">Paint every shape in one colour.</p>
            )}
          </Field>
        </Collapsible>

        {/* Options that don't apply to this image, with the reason. */}
        {inert.length > 0 && (
          <Collapsible title="Looking for another option?" summary={`${inert.length} don’t apply to this image`}>
            <p className="text-xs leading-snug text-muted">
              These can’t change this trace, so they are tucked away here. Each one says what would make it apply.
            </p>
            <ul className="flex flex-col gap-3">
              {inert.map((c) => (
                <li key={c.label} className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-ink-2">{c.label}</span>
                  <span className="text-xs leading-snug text-muted">{c.why}</span>
                </li>
              ))}
            </ul>
          </Collapsible>
        )}

        <div className="mt-auto border-t border-line pt-4">
          <p className="text-[0.7rem] leading-relaxed text-faint">
            V pan · A edit nodes · M mark regions · ⌫ delete nodes (with none selected, removes the clicked region and
            fills it from its neighbour) · double-click a segment to add a node.
          </p>
        </div>
      </div>

      {/* Pinned action footer. */}
      <div className="flex shrink-0 flex-col gap-3 border-t border-line bg-surface p-4">
        {(staleEdits || staleOpts) && (
          <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>
              {staleEdits
                ? 'Settings changed since the last trace. Re-tracing applies them and discards your path edits.'
                : 'Tracing was stopped, so this result may not match the current settings. Re-trace to apply them.'}
            </span>
          </div>
        )}

        <Button
          variant="primary"
          block
          icon={<WandSparkles size={16} />}
          onClick={onTrace}
          disabled={busy}
          className="h-11 text-[0.95rem] font-semibold shadow-sm"
        >
          {busy
            ? 'Tracing…'
            : staleEdits
              ? 'Re-trace (discard edits)'
              : staleOpts
                ? 'Re-trace'
                : tracing
                  ? 'Trace'
                  : 'Clean SVG'}
        </Button>
      </div>

      {infoId && <ControlInfoDialog controlId={infoId} onClose={() => setInfoId(null)} />}
    </>
  )
}

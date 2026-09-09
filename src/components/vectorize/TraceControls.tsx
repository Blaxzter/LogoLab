// Left rail of the vectorize studio: trace parameters grouped into collapsible
// sections (Shape & detail / Color & background) to keep the panel uncluttered,
// plus the pinned Trace button. Every tuning knob carries a short hint and an (i)
// that opens a per-control teaching dialog (ControlInfoDialog). Pure controlled
// UI — all trace state lives in VectorizeStudio; only the "which info dialog is
// open" state is local.

import { useState } from 'react'
import { Wand2, HelpCircle, AlertTriangle, MapPin, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { ColorField, Collapsible, Field, Segmented, Slider, Toggle } from '../ui/controls'
import { Tooltip } from '../ui/Tooltip'
import type { VectorizeOptions } from '../../types'
import type { InkColorMode, InkModePlan } from '../../lib/ink'
import { CONTROL_DOCS_BY_ID } from './controlDocs'
import { ControlInfoDialog } from './ControlInfoDialog'
import { AI_UPSCALE_MAX_PX, aiUpscaleFactor } from '../../lib/aiUpscale'

export interface TraceControlsProps {
  /** The upload is an SVG, so "clean existing markup" is an option. */
  isVectorSource: boolean
  source: 'clean' | 'retrace'
  onSourceChange: (v: 'clean' | 'retrace') => void
  opts: VectorizeOptions
  onPatch: (patch: Partial<VectorizeOptions>) => void
  /** Longest side of the source image (px), for the Detail preset's effect hint. */
  sourceMaxDim?: number
  /** Colour-vs-mono choice: `auto` defers to the ink probe (src/lib/ink.ts). */
  colorMode: InkColorMode
  onColorMode: (m: InkColorMode) => void
  /** What the ink probe last saw, so Auto can say what it decided and why. */
  inkPlan: InkModePlan | null
  /**
   * What the CURRENT mono cut admits, so Threshold and Invert can show their own
   * consequence. A control that can silently reach a state producing nothing is
   * the defect (#47); this is what makes that state visible on the control.
   * Null outside mono, or before the probe lands.
   */
  monoGuide: {
    /** Cuts at or below this select nothing with Invert OFF. */
    deadOff: number
    /** Cuts at or above this select nothing with Invert ON. */
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
}

const d = CONTROL_DOCS_BY_ID

/** A fraction as a percentage, keeping one decimal while it is still visible —
 *  "0.4%" is a thin hairline that traces; rounding it to "0%" would be a lie. */
function pct(f: number): string {
  if (f === 0) return '0%'
  if (f < 0.01) return `${(f * 100).toFixed(1)}%`
  return `${Math.round(f * 100)}%`
}

/** Desktop rail — the 320px column. Below md it's hidden; the same body renders
 *  inside the studio's "Trace" bottom sheet instead (see VectorizeStudio). */
export function TraceControls(props: TraceControlsProps) {
  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-r border-line bg-surface md:flex">
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
}: TraceControlsProps) {
  const tracing = !isVectorSource || source === 'retrace'
  const [infoId, setInfoId] = useState<string | null>(null)
  const info = (id: string) => () => setInfoId(id)

  const engine = opts.engine ?? 'planar'
  const engineLabel = engine === 'planar' ? 'Planar' : engine === 'crisp' ? 'Crisp' : 'Potrace'
  const detailSummary = tracing
    ? opts.mode === 'mono'
      ? `Mono · threshold ${opts.threshold}${opts.invert ? ' · inverted' : ''}`
      : `${engineLabel} · smoothing ${opts.smoothing}`
    : 'Cleaning SVG markup'
  const colorSummary =
    opts.mode === 'color' && opts.gradients !== false ? 'Gradients on' : 'Flat fills'

  // The AI upscaler only acts on SMALL rasters (see aiUpscale.ts): an SVG source
  // rasterizes at full detail, and past AI_UPSCALE_MAX_PX enlarging stops paying
  // for itself. Rather than show a dial whose own hint says it does nothing, hide
  // it — but keep it visible while it is switched ON, so a setting carried over
  // from a smaller image can still be turned off.
  const upscaleInert = isVectorSource || (sourceMaxDim != null && !aiUpscaleFactor(sourceMaxDim))
  const showUpscale = !upscaleInert || (opts.upscale ?? 'off') !== 'off'

  // Mono cut consequences (#47). The cut is the one control that can silently
  // yield NOTHING — a single global threshold with all the ink on one side of it.
  // Rather than explain the blank afterwards, price both Invert positions and
  // strike out the cuts that cannot work, so it is visible before it is chosen.
  // The dead span is drawn, never enforced: the estimate behind it can be wrong on
  // unusual art, so the override stays reachable.
  const inverted = opts.invert === true
  const deadCuts = monoGuide
    ? inverted
      ? [{ from: monoGuide.deadOn, to: 255 }]
      : [{ from: 0, to: monoGuide.deadOff }]
    : undefined

  return (
    <>
      {/* Scrollable settings — the action below stays pinned so it can't scroll away. */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Vectorize</h2>
            <Tooltip label="See how vectorize turns your image into shapes">
              <button
                type="button"
                onClick={onShowHelp}
                className="btn btn-ghost h-7 gap-1 px-2 text-xs text-ink-2"
              >
                <HelpCircle size={14} />
                How it works
              </button>
            </Tooltip>
          </div>

          {isVectorSource && (
            <>
              <Field label="Source" hint="Re-tracing rasterizes the SVG, then rebuilds vector paths.">
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
                  Already vector — cleaning the existing SVG. Switch to Re-trace to rebuild paths from
                  pixels instead.
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
              {/* What Auto decided, in the probe's own terms. A choice the user
                  can't see is a choice they can't overrule. */}
              {colorMode === 'auto' && inkPlan && (
                <p className="text-xs leading-snug text-muted">
                  {inkPlan.inks === 0
                    ? 'Nothing but background found — tracing in colour.'
                    : inkPlan.mode === 'mono'
                      ? `One ink${inkPlan.invert ? ', lighter than the background' : ''} → Mono, cut at ${inkPlan.threshold}${
                          inkPlan.invert ? ' and inverted' : ''
                        }${inkPlan.recolor ? `, painted ${inkPlan.recolor}` : ''}.`
                      : inkPlan.inks === 1
                        ? // One ink, but not far enough from the background in
                          // luminance for a cut to separate them — which is the
                          // normal case for art on transparency.
                          'One ink, too close to the background to cut → Color.'
                        : `${inkPlan.inks} inks → Color.`}
                </p>
              )}
            </Field>
          )}

          {tracing && (
            <Collapsible title="Shape & detail" summary={detailSummary} defaultOpen>
              <Field label="Engine" hint={d.engine.hint} onInfo={info('engine')}>
                <Segmented<'planar' | 'crisp' | 'potrace'>
                  value={engine}
                  onChange={(v) => onPatch({ engine: v })}
                  options={[
                    { value: 'planar', label: 'Planar' },
                    { value: 'crisp', label: 'Crisp' },
                    { value: 'potrace', label: 'Potrace' },
                  ]}
                />
              </Field>

              <Field
                label="Detail"
                hint={
                  !(opts.mode === 'mono' || opts.gradients === false)
                    ? 'Applies to flat art; gradient/photo stays capped at 1024px for speed.'
                    : (sourceMaxDim ?? 0) > 2048
                      ? 'High traces large sources up to 4096px — crisper edges, slower trace.'
                      : `Source${sourceMaxDim ? ` (${sourceMaxDim}px)` : ''} is already at full detail; High has no effect.`
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

              {showUpscale && (
              <Field
                label="Upscale"
                hint={
                  isVectorSource
                    ? 'SVG sources rasterize at full detail — nothing to upscale.'
                    : sourceMaxDim && !aiUpscaleFactor(sourceMaxDim)
                      ? `Source (${sourceMaxDim}px) is above ${AI_UPSCALE_MAX_PX}px, where enlarging stops helping; no effect.`
                      : `AI enlarges a small raster ×${sourceMaxDim ? aiUpscaleFactor(sourceMaxDim) || 2 : '2–4'} before tracing (waifu2x, in your browser: ~17–19 MB once, a few seconds per trace). Measured: cleaner corners and fewer nodes than tracing it small.`
                }
              >
                <Segmented<'off' | 'ai'>
                  value={opts.upscale ?? 'off'}
                  onChange={(v) => onPatch({ upscale: v })}
                  options={[
                    { value: 'off', label: 'Off' },
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

                  {/* The other half of a mono cut: WHICH side of it becomes solid.
                      Without this, light art on a dark ground traces to nothing —
                      every pixel of it sits above the cut. */}
                  <Field label="Invert" hint={d.invert.hint} onInfo={info('invert')}>
                    <Toggle
                      checked={opts.invert === true}
                      onChange={(v) => onPatch({ invert: v })}
                      label="Light ink on a dark ground"
                    />
                    {/* Both positions, priced. The whole point of #47: you can see
                        which one selects nothing WITHOUT having to pick it first. */}
                    {monoGuide && (
                      <p className="text-xs leading-snug text-muted tabular-nums">
                        At this cut — off takes{' '}
                        <span className={opts.invert ? '' : 'font-semibold text-ink-2'}>
                          {pct(monoGuide.fracOff)}
                        </span>{' '}
                        of the visible pixels, on takes{' '}
                        <span className={opts.invert ? 'font-semibold text-ink-2' : ''}>
                          {pct(monoGuide.fracOn)}
                        </span>
                        .
                      </p>
                    )}
                  </Field>

                </>
              )}

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
              {/* No master switch — the markers ARE the feature: with none placed the
                  trace is byte-identical, and placing one turns it on. */}
              <p className="text-xs leading-snug text-muted">
                Seed the segmentation per spot: keep a region <em>separate</em> from its
                neighbour, paint it one <em>flat</em> colour, or <em>remove</em> it and heal
                the neighbours into the gap. No markers ⇒ output unchanged.
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
                {marking ? 'Placing — click the image' : 'Place markers'}
              </button>
              <p className="text-xs leading-snug text-muted">
                {marking
                  ? 'Click either pane to drop a marker; click a marker to remove it. Turn off to pan and edit — markers stay active.'
                  : 'Markers stay active while you pan, zoom and edit. Turn on to place more.'}
              </p>

              {/* Marker kind: a click drops this type. "Separate" keeps the
                  region distinct (paint untouched); "Flat" also pins it to one
                  solid colour (its pre-merge form), not a fitted gradient;
                  "Remove" dissolves the section and heals the neighbours in. */}
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
                    ? 'Remove: dissolves the clicked section and grows its bordering colours into the gap (split along the middle) — heals instead of leaving a hole. Re-traces on next run.'
                    : 'Separate: keep this region distinct; its gradient/flat paint is left as fitted. Mark both sides of an over-merge to set the boundary on the colour ridge.'}
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
            {tracing && opts.mode === 'color' && (
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
                label="Drop the dominant backplate"
              />
            </Field>

            <Field
              label="Force single color"
              right={<Toggle checked={forceColorOn} onChange={onForceColorOn} />}
            >
              {forceColorOn ? (
                <ColorField value={forceColor} onChange={onForceColor} />
              ) : (
                <p className="text-xs leading-snug text-muted">Recolor every shape to one fill.</p>
              )}
            </Field>
          </Collapsible>

          <div className="mt-auto border-t border-line pt-4">
            <p className="text-[0.7rem] leading-relaxed text-faint">
              V pan · A edit nodes · M mark regions · ⌫ delete nodes — or, with none selected, dissolve the clicked region and heal it into its neighbour · double-click a segment to add a node.
            </p>
          </div>
        </div>

        {/* Pinned action footer — always visible no matter how far the settings scroll. */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-line bg-surface p-4">
          {(staleEdits || staleOpts) && (
            <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                {staleEdits
                  ? "Settings changed since the last trace. Re-trace to apply them — this discards your path edits."
                  : "Tracing was stopped, so this result may not match the current settings. Re-trace to apply them."}
              </span>
            </div>
          )}

          <Button
            variant="primary"
            block
            icon={<Wand2 size={16} />}
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

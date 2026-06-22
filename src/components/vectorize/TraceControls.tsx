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
import { CONTROL_DOCS_BY_ID } from './controlDocs'
import { ControlInfoDialog } from './ControlInfoDialog'

export interface TraceControlsProps {
  /** The upload is an SVG, so "clean existing markup" is an option. */
  isVectorSource: boolean
  source: 'clean' | 'retrace'
  onSourceChange: (v: 'clean' | 'retrace') => void
  opts: VectorizeOptions
  onPatch: (patch: Partial<VectorizeOptions>) => void
  forceColorOn: boolean
  onForceColorOn: (v: boolean) => void
  forceColor: string
  onForceColor: (v: string) => void
  /** Region-marker (segmentation seed) state, lifted from VectorizeStudio. */
  regionsEnabled: boolean
  onRegionsEnabledChange: (on: boolean) => void
  marking: boolean
  onMarkingChange: (on: boolean) => void
  markerCount: number
  /** How many of the markers are tagged "flat". */
  flatCount: number
  /** Which kind of marker a click drops. */
  markMode: 'separate' | 'flat'
  onMarkModeChange: (m: 'separate' | 'flat') => void
  onClearMarkers: () => void
  busy: boolean
  /** Params changed while the doc carries manual edits — re-trace discards them. */
  staleEdits: boolean
  onTrace: () => void
  /** Open the "How it works" pipeline explainer. */
  onShowHelp: () => void
}

const d = CONTROL_DOCS_BY_ID

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
  forceColorOn,
  onForceColorOn,
  forceColor,
  onForceColor,
  regionsEnabled,
  onRegionsEnabledChange,
  marking,
  onMarkingChange,
  markerCount,
  flatCount,
  markMode,
  onMarkModeChange,
  onClearMarkers,
  busy,
  staleEdits,
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
      ? `Mono · threshold ${opts.threshold}`
      : `${engineLabel} · smoothing ${opts.smoothing}`
    : 'Cleaning SVG markup'
  const colorSummary =
    opts.mode === 'color' && opts.gradients !== false ? 'Gradients on' : 'Flat fills'

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
            <Field label="Mode">
              <Segmented<'color' | 'mono'>
                value={opts.mode}
                onChange={(v) => onPatch({ mode: v })}
                options={[
                  { value: 'color', label: 'Color' },
                  { value: 'mono', label: 'Mono' },
                ]}
              />
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

              {opts.mode === 'mono' && (
                <Field label="Threshold" hint={d.threshold.hint} onInfo={info('threshold')}>
                  <Slider value={opts.threshold} min={0} max={255} onChange={(v) => onPatch({ threshold: v })} />
                </Field>
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
                !regionsEnabled
                  ? undefined
                  : marking
                    ? `Placing · ${markerCount} marker${markerCount === 1 ? '' : 's'}`
                    : `On · ${markerCount} marker${markerCount === 1 ? '' : 's'}`
              }
            >
              {/* Step 1 — master switch: are we using region markers at all? */}
              <Field
                label="Use region markers"
                hint={d.markers.hint}
                onInfo={info('markers')}
                right={<Toggle checked={regionsEnabled} onChange={onRegionsEnabledChange} />}
              >
                <p className="text-xs leading-snug text-muted">
                  Seed the segmentation per spot: keep a region <em>separate</em> from its
                  neighbour, or paint it one <em>flat</em> colour instead of a gradient. Hovering
                  the image highlights the region you'd mark.
                </p>
              </Field>

              {/* Step 2 — region mode: placement on (click to seed) vs off (pan freely). */}
              {regionsEnabled && (
                <>
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
                      solid colour (its pre-merge form), not a fitted gradient. */}
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-line p-1">
                    {(
                      [
                        ['separate', 'Keep separate', 'text-emerald-600 dark:text-emerald-400'],
                        ['flat', 'Flat colour', 'text-amber-600 dark:text-amber-400'],
                      ] as const
                    ).map(([mode, label, active]) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={markMode === mode}
                        onClick={() => onMarkModeChange(mode)}
                        className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                          markMode === mode ? `bg-surface-3 ${active}` : 'text-ink-2 hover:bg-surface-2'
                        }`}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: mode === 'flat' ? '#f59e0b' : '#10b981' }}
                        />
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs leading-snug text-muted">
                    {markMode === 'flat'
                      ? 'Flat: this region paints one solid colour instead of a gradient, and stays its own shape. Mark both sides of a pair the tracer fused under a gradient.'
                      : 'Separate: keep this region from merging into its neighbour; its gradient/flat paint is left as fitted.'}
                  </p>

                  {markerCount > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs text-ink-2">
                        <MapPin size={12} className="text-emerald-500" />
                        {markerCount} marker{markerCount === 1 ? '' : 's'}
                        {flatCount > 0 ? ` · ${flatCount} flat` : ''}
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
                </>
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
              V pan · A edit nodes · M mark regions · ⌫ delete · double-click a segment to add a node.
            </p>
          </div>
        </div>

        {/* Pinned action footer — always visible no matter how far the settings scroll. */}
        <div className="flex shrink-0 flex-col gap-3 border-t border-line bg-surface p-4">
          {staleEdits && (
            <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-snug text-warn">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                Settings changed since the last trace. Re-trace to apply them — this discards your
                path edits.
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
                : tracing
                  ? 'Trace'
                  : 'Clean SVG'}
          </Button>
        </div>

      {infoId && <ControlInfoDialog controlId={infoId} onClose={() => setInfoId(null)} />}
    </>
  )
}

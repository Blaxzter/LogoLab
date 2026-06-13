// Left rail of the vectorize studio: trace parameters (mode, colors,
// smoothing…), output options (force color) and the Trace button.
// Pure controlled UI — all state lives in VectorizeStudio.

import { Wand2, HelpCircle, AlertTriangle } from 'lucide-react'
import { Button } from '../ui/Button'
import { ColorField, Field, Segmented, Slider, Toggle } from '../ui/controls'
import type { VectorizeOptions } from '../../types'

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
  busy: boolean
  /** Params changed while the doc carries manual edits — re-trace discards them. */
  staleEdits: boolean
  onTrace: () => void
  /** Open the "How it works" pipeline explainer. */
  onShowHelp: () => void
}

export function TraceControls({
  isVectorSource,
  source,
  onSourceChange,
  opts,
  onPatch,
  forceColorOn,
  onForceColorOn,
  forceColor,
  onForceColor,
  busy,
  staleEdits,
  onTrace,
  onShowHelp,
}: TraceControlsProps) {
  const tracing = !isVectorSource || source === 'retrace'

  return (
    <aside className="flex w-[270px] shrink-0 flex-col border-r border-line bg-surface">
      {/* Scrollable settings — the action below stays pinned so it can't scroll away. */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Vectorize</h2>
        <button
          type="button"
          onClick={onShowHelp}
          className="btn btn-ghost h-7 gap-1 px-2 text-xs text-ink-2"
          title="See how vectorize turns your image into shapes"
        >
          <HelpCircle size={14} />
          How it works
        </button>
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
        <>
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

          {opts.mode === 'mono' && (
            <Field label="Threshold" hint="Pixels darker than this become solid; lighter ones drop out.">
              <Slider value={opts.threshold} min={0} max={255} onChange={(v) => onPatch({ threshold: v })} />
            </Field>
          )}

          <Field label="Engine" hint="Crisp = cleanest, fewest nodes. Potrace = closest to the pixels.">
            <Segmented<'crisp' | 'potrace'>
              value={opts.engine ?? 'crisp'}
              onChange={(v) => onPatch({ engine: v })}
              options={[
                { value: 'crisp', label: 'Crisp' },
                { value: 'potrace', label: 'Potrace' },
              ]}
            />
          </Field>

          <Field label="Smoothing" hint="Curve fitting — higher melts detail into smooth curves.">
            <Slider value={opts.smoothing} min={0} max={100} onChange={(v) => onPatch({ smoothing: v })} />
          </Field>

          <Field label="Despeckle" hint="Suppresses anti-aliasing slivers and speckles.">
            <Slider value={opts.despeckle} min={0} max={100} onChange={(v) => onPatch({ despeckle: v })} />
          </Field>

          <Field
            label="Fidelity"
            hint="Snap traced shapes to perfect circles, lines and shared centers. Lower stays faithful to the pixels; higher allows more drift for cleaner geometry. 0 disables snapping."
          >
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
            <Field
              label="Region detail"
              hint="How finely the image is split into shapes. Higher recovers subtle regions — like where translucent shapes overlap — but can break smooth gradients into flat bands and is slower. 'auto' is the balanced default."
            >
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

          {opts.mode === 'color' && (
            <Field
              label="Gradients"
              hint="Detect smooth color ramps and export them as real SVG gradients instead of flat bands."
            >
              <Toggle
                checked={opts.gradients !== false}
                onChange={(v) => onPatch({ gradients: v })}
                label="Fit smooth gradients"
              />
            </Field>
          )}
        </>
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

        <div className="mt-auto border-t border-line pt-4">
          <p className="text-[0.7rem] leading-relaxed text-faint">
            V pan · A edit nodes · ⌫ delete · double-click a segment to add a node.
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
    </aside>
  )
}

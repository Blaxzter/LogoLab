// Left rail of the vectorize studio: trace parameters (mode, colors,
// smoothing…), output options (force color, precision) and the Trace button.
// Pure controlled UI — all state lives in VectorizeStudio.

import { Wand2 } from 'lucide-react'
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
  precision: number
  onPrecision: (v: number) => void
  forceColorOn: boolean
  onForceColorOn: (v: boolean) => void
  forceColor: string
  onForceColor: (v: string) => void
  busy: boolean
  /** Params changed while the doc carries manual edits — re-trace discards them. */
  staleEdits: boolean
  onTrace: () => void
}

export function TraceControls({
  isVectorSource,
  source,
  onSourceChange,
  opts,
  onPatch,
  precision,
  onPrecision,
  forceColorOn,
  onForceColorOn,
  forceColor,
  onForceColor,
  busy,
  staleEdits,
  onTrace,
}: TraceControlsProps) {
  const tracing = !isVectorSource || source === 'retrace'

  return (
    <aside className="flex w-[270px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">Vectorize</h2>

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

          {opts.mode === 'color' ? (
            <Field label="Colors" hint="How many fill colors to quantize to.">
              <Slider value={opts.colors} min={2} max={24} onChange={(v) => onPatch({ colors: v })} />
            </Field>
          ) : (
            <Field label="Threshold" hint="Pixels darker than this become solid; lighter ones drop out.">
              <Slider value={opts.threshold} min={0} max={255} onChange={(v) => onPatch({ threshold: v })} />
            </Field>
          )}

          <Field
            label="Engine"
            hint="Crisp = sub-pixel Bézier fitting with evidence-based corners — the lowest node count and sharp corners, best for line-art / solid shapes. Potrace = classic tracer — highest pixel fidelity and the cleanest abutting/translucent edges."
          >
            <Segmented<'crisp' | 'potrace'>
              value={opts.engine ?? 'potrace'}
              onChange={(v) => onPatch({ engine: v })}
              options={[
                { value: 'potrace', label: 'Potrace' },
                { value: 'crisp', label: 'Crisp' },
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

      <Field label="Precision" hint="Decimal places kept in path coordinates.">
        <Slider value={precision} min={0} max={3} onChange={onPrecision} />
      </Field>

      {staleEdits && (
        <p className="text-xs leading-snug text-warn">
          Settings changed — Re-trace discards your path edits.
        </p>
      )}

      <Button variant="primary" block icon={<Wand2 size={15} />} onClick={onTrace} disabled={busy}>
        {busy
          ? 'Tracing…'
          : staleEdits
            ? 'Re-trace (discard edits)'
            : tracing
              ? 'Trace'
              : 'Clean SVG'}
      </Button>

      <div className="mt-auto border-t border-line pt-4">
        <p className="text-[0.7rem] leading-relaxed text-faint">
          V pan · A edit nodes · ⌫ delete · double-click a segment to add a node.
        </p>
      </div>
    </aside>
  )
}

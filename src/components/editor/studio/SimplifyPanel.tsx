// The Simplify path panel: a tolerance slider over a live preview, and the
// node count it buys. Floats over the stage rather than living in the
// properties rail, so the context menu can open it on a narrow screen too.

import { percentSlider, sliderPercent } from '../../../lib/editor/simplify'
import { Waypoints } from '../../ui/icons'
import { RangeInput } from '../../ui/RangeInput'
import { TipLabel, Tooltip } from '../../ui/Tooltip'
import type { SimplifyView } from './useEditorModel'

/** A percentage to two significant figures: 0.05%, 0.5%, 2.4%. */
const pct = (p: number) => `${+p.toPrecision(2)}%`

export function SimplifyPanel({
  view,
  setPercent,
  apply,
  cancel,
}: {
  view: SimplifyView
  setPercent: (percent: number) => void
  apply: () => void
  cancel: () => void
}) {
  const saved = view.before - view.after
  return (
    <div
      role="dialog"
      aria-label="Simplify path"
      className="absolute right-3 top-3 z-20 w-64 rounded-xl border border-line bg-surface p-3 shadow-lg animate-in-fade"
      // The slider has focus while it is dragged; Enter, Esc and undo still
      // answer (the window's shortcuts skip a focused input). A focused button
      // answers Enter itself — Enter on Cancel cancels.
      onKeyDown={(e) => {
        const mod = e.ctrlKey || e.metaKey
        if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault()
          apply()
        } else if (e.key === 'Escape' || (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y'))) {
          e.preventDefault()
          e.stopPropagation()
          cancel()
        }
      }}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <Waypoints size={14} className="text-accent" />
        <h4 className="field-label">Simplify path</h4>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-[0.7rem] text-muted">Tolerance</span>
        <Tooltip
          label={
            <TipLabel
              title="How far the simplified path may stray"
              detail="A share of each path’s larger side. Corners stay sharp and straight sides stay straight at any setting."
            />
          }
        >
          <RangeInput
            min={0}
            max={100}
            step={1}
            wheelStep={5}
            value={Math.round(percentSlider(view.percent))}
            aria-label="Simplify tolerance"
            onValue={(v) => setPercent(sliderPercent(v))}
            className="min-w-0 flex-1 accent-[var(--color-accent)]"
          />
        </Tooltip>
        <span className="w-11 shrink-0 text-right text-[0.7rem] tabular-nums text-muted">{pct(view.percent)}</span>
      </div>
      <p className="mt-2 text-[0.72rem] tabular-nums text-ink-2" aria-live="polite">
        <span className="font-medium text-ink">
          {view.before} → {view.after} nodes
        </span>
        {view.before > 0 && saved > 0 && (
          <span className="text-muted"> ({Math.round((100 * saved) / view.before)}% fewer)</span>
        )}
        {saved === 0 && <span className="text-muted"> (nothing to remove at this tolerance)</span>}
      </p>
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button type="button" className="btn btn-secondary h-7 px-2.5 text-xs" onClick={cancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary h-7 px-2.5 text-xs" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  )
}

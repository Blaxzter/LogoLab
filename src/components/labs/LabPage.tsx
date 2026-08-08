import { createContext, useContext, useEffect, useId, useRef } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode } from 'react'
import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePanZoom } from '../../hooks/usePanZoom'
import type { PanZoom } from '../../hooks/usePanZoom'
import { Tooltip } from '../ui/Tooltip'
import { Select } from '../ui/Select'
import type { SelectOption } from '../ui/Select'
import { useLabState } from './useLabState'
import './labs.css'

/**
 * The shell every lab wears: a sticky compact toolbar, a collapsible "about" that
 * remembers whether you've read it, and a status line.
 *
 * `vectorize-golden` and `vectorize-truth` had grown this shape by hand; the other
 * three still carried a fixed header wall of prose that ate the screen the data was
 * supposed to be on. One shell fixes all five — the explanation is worth reading once
 * and worth getting out of the way every time after.
 */

/**
 * The camera panels bind to. Cameras are PER ROW (CaseRow provides one), so a detail
 * stays framed across the source, the trace and the error maps of ONE case — while
 * every other row keeps its own framing (zooming bloom's crossing must not fling
 * hairlines' bars off-screen). `claimed` is how the first panel under a camera
 * registers itself as the box the row's +/- buttons zoom around — automatic, so no
 * lab has to thread a `primary` flag row by row. LabPage still provides a fallback
 * camera for any panel rendered outside a row.
 */
export interface LabZoom {
  pz: PanZoom
  claimed: MutableRefObject<boolean>
}

export const LabZoomContext = createContext<LabZoom | null>(null)

export function useLabZoom(): LabZoom {
  const z = useContext(LabZoomContext)
  if (!z) throw new Error('lab panels must be rendered inside a <LabPage>')
  return z
}

/** Page-wide "Dark bg" toggle: sit every panel's art on the near-black backdrop
 *  instead of the transparency checkerboard — white-on-transparent art is
 *  invisible on the light board. Panels read it from here. */
export const LabDarkContext = createContext(false)

export const useLabDark = (): boolean => useContext(LabDarkContext)

/** Panel side length, in px — the range the box-size slider offers. */
export const BOX_RANGE = { min: 180, max: 900 }

export function LabPage({
  storageKey,
  title,
  subtitle,
  about,
  controls,
  status,
  running = false,
  progress,
  box,
  onBox,
  wires = false,
  children,
}: {
  /** Namespaces the persisted "about is open" flag. Use the lab's state key. */
  storageKey: string
  title: string
  subtitle: string
  about: ReactNode
  /** Lab-specific toolbar controls (rendered between the title and the zoom pill). */
  controls?: ReactNode
  status: string
  running?: boolean
  /** Drives the run progress bar (from useLabRun). `cached` of them were served from the store. */
  progress?: { done: number; total: number; cached: number }
  box: number
  onBox: (v: number) => void
  /** Reveal the nodes/edges wireframe baked into every trace (pure CSS — no re-trace). */
  wires?: boolean
  children: ReactNode
}) {
  // Fallback camera for panels rendered outside a CaseRow (rows own their real ones).
  const pz = usePanZoom({ maxScale: 40 })
  const claimed = useRef(false)
  const [ui, setUi] = useLabState(`${storageKey}:ui`, { about: false, dark: false })

  useEffect(() => pz.reset(), [pz.reset])

  return (
    <LabZoomContext.Provider value={{ pz, claimed }}>
      <div
        className={`min-h-full ${wires ? 'wires' : ''}`}
        style={{ '--lab-box': `${box}px` } as CSSProperties}
      >
        <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
            <Link
              to="/labs"
              className="btn btn-ghost h-8 shrink-0 gap-1.5 px-2 text-xs"
              aria-label="All labs"
            >
              <ArrowLeft size={14} />
              Labs
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-ink">{title}</h1>
              <p className="truncate text-[0.7rem] leading-tight text-muted">{subtitle}</p>
            </div>
            <div className="hidden h-5 w-px shrink-0 bg-line sm:block" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
              {controls}
              <LabCheck
                label="Dark bg"
                hint="Sit every panel's art on a near-black backdrop instead of the checkerboard — white-on-transparent art is invisible on the light board."
                checked={ui.dark}
                onChange={(dark) => setUi({ dark })}
              />
              <LabField
                label="Box"
                hint="Panel size. Drag to make every panel — source, trace and error maps — bigger or smaller."
              >
                <input
                  type="range"
                  min={BOX_RANGE.min}
                  max={BOX_RANGE.max}
                  step={10}
                  value={box}
                  onChange={(e) => onBox(Number(e.target.value))}
                  className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-line-strong"
                  aria-label="Panel size"
                />
              </LabField>
            </div>
          </div>

          <details
            open={ui.about}
            onToggle={(e) => setUi({ about: (e.currentTarget as HTMLDetailsElement).open })}
            className="border-t border-dashed border-line"
          >
            <summary className="flex cursor-pointer select-none items-center gap-1 px-4 py-1.5 text-[0.7rem] text-muted transition-colors hover:bg-surface-2 hover:text-ink-2 [&::-webkit-details-marker]:hidden">
              <ChevronDown
                size={12}
                className={`shrink-0 transition-transform ${ui.about ? 'rotate-180' : ''}`}
              />
              What this page is, and how to read each panel
            </summary>
            <div className="lab-prose max-h-[46vh] overflow-y-auto px-4 pb-3 text-xs leading-relaxed text-muted">
              {about}
            </div>
          </details>
        </header>

        <div className="px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            {running && <Loader2 size={13} className="shrink-0 animate-spin text-accent" />}
            <span className="min-w-0 truncate">{status}</span>
            {/* While running: live count. After a run that hit the cache: keep the "N cached"
                note, so an instant load still shows WHY it was instant. */}
            {progress && progress.total > 0 && (running || progress.cached > 0) && (
              <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-[0.68rem] text-faint">
                {progress.done}/{progress.total}
                {progress.cached > 0 && ` · ${progress.cached} cached`}
              </span>
            )}
          </div>
          {/* The run fills the corpus one case at a time; the bar tracks it, and a run that is
              entirely cache hits just blips to full. */}
          {progress && progress.total > 1 && running && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line-strong">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>

        <main>
          <LabDarkContext.Provider value={ui.dark}>{children}</LabDarkContext.Provider>
        </main>
      </div>
    </LabZoomContext.Provider>
  )
}

/** A toolbar control with its label — the labs' `<label>Box <input/></label>` idiom.
 *  Pass `hint` to attach a hover/focus tooltip explaining what the control does. */
export function LabField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  const field = (
    <label className="inline-flex items-center gap-1.5 text-muted">
      <span className="whitespace-nowrap">{label}</span>
      {children}
    </label>
  )
  // Drop the bubble BELOW the sticky toolbar, where there's room — a top-side bubble on a
  // top-of-viewport control just clamps against the edge.
  return hint ? (
    <Tooltip label={hint} side="bottom">
      {field}
    </Tooltip>
  ) : (
    field
  )
}

/** The labs' dropdown — a {@link Select}, not a native `<select>`, so it wears the app's
 *  theme and its groups read as section structure (see that file for why).
 *
 *  It lays out its own label rather than going through {@link LabField}, for one
 *  reason: LabField hangs the hint bubble under the WHOLE field, which is exactly where
 *  the open list lands. Hover-the-label keeps the hint reachable without it covering
 *  the options — and the label needs an id anyway, to name the combobox the way the
 *  native control's wrapping `<label>` used to. */
export function LabSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  hint,
}: {
  value: T
  /** `group` puts the option in a titled section; ungrouped options come first, in
   *  order. Groups appear in the order their first option does, so the caller controls
   *  the layout by list order alone. `note` is dimmed metadata trailing the label. */
  options: SelectOption<T>[]
  onChange: (v: T) => void
  label: string
  hint?: ReactNode
}) {
  const labelId = useId()
  return (
    <span className="inline-flex items-center gap-1.5 text-muted">
      <Tooltip label={hint} side="bottom">
        <span id={labelId} className="whitespace-nowrap">
          {label}
        </span>
      </Tooltip>
      <Select value={value} options={options} onChange={onChange} labelledBy={labelId} />
    </span>
  )
}

/** A toolbar checkbox — same idiom, app styling. `hint` attaches an explaining tooltip. */
export function LabCheck({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: ReactNode
}) {
  const field = (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[var(--color-accent)]"
      />
      <span className="whitespace-nowrap">{label}</span>
    </label>
  )
  return hint ? (
    <Tooltip label={hint} side="bottom">
      {field}
    </Tooltip>
  ) : (
    field
  )
}

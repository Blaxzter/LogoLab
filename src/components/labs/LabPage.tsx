import { createContext, useContext, useEffect, useId, useMemo, useRef } from 'react'
import type { CSSProperties, MutableRefObject, ReactNode, RefObject } from 'react'
import { ArrowLeft, ChevronDown, Loader2, Search, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { usePanZoom } from '../../hooks/usePanZoom'
import type { PanZoom } from '../../hooks/usePanZoom'
import { Tooltip } from '../ui/Tooltip'
import { Select } from '../ui/Select'
import type { SelectOption } from '../ui/Select'
import { useLabState } from './useLabState'
import type { LabSearchState } from './useLabSearch'
import { searchElsewhere, type Elsewhere } from './corpusIndex'
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

/** What a lab hands {@link LabPage} to get the corpus search box. The counts are the lab's
 *  to supply — only it knows how big its corpus is before the filter and after it — and they
 *  are what turns the box from a text field into a readout: `12/231` while you type. */
export interface LabSearchProps {
  state: LabSearchState
  /** Cases the query matched (across the WHOLE corpus, not the current page). */
  matched: number
  /** Cases there are, unfiltered. */
  total: number
  /** What a case is called here, singular — 'case', 'logo', 'mark'. */
  noun?: string
  /**
   * Which corpus this is, in `corpusIndex`'s `CORPUS_PLACES` terms (`workbench:tier0`, … ) —
   * a list where a lab shows several at once (A/B's two lanes). Supplying it turns on
   * "…also in": the corpora don't overlap, so a name you can picture is often simply not in
   * the one you're looking at, and a bare "no match" reads as "we don't have it" when the
   * truth is "not on this page". Omit it and every indexed corpus is fair game to point at.
   */
  here?: string | readonly string[]
}

export function LabPage({
  storageKey,
  title,
  subtitle,
  about,
  controls,
  search,
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
  /** Filter the corpus by name from the toolbar. See {@link useLabSearch} — it filters the
   *  case LIST, so a match is a trace away whatever page it lived on. */
  search?: LabSearchProps
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
  const searchRef = useRef<HTMLInputElement>(null)

  // Every OTHER corpus the settled query hits. Computed here, once, and used in two places (the
  // counter line and the empty state) — it walks every indexed corpus, so it must not be a thing
  // each of them recomputes. Only while a query is actually biting: with an empty box the answer
  // is "everything, everywhere", which is not a finding.
  const sq = search?.state.active ? search.state.q : ''
  const sMatch = search?.state.match
  const sHere = search?.here
  const elsewhere = useMemo(
    () => (sq && sMatch ? searchElsewhere(sMatch, sHere) : []),
    [sq, sMatch, sHere],
  )

  useEffect(() => pz.reset(), [pz.reset])

  // `/` jumps to the search box from anywhere on the page — these are long, scrolling pages
  // and the toolbar is sticky but the box is one control among a dozen. Typing `/` INTO a
  // field (this one included) has to stay a slash, so any editable target is left alone.
  const hasSearch = search != null
  useEffect(() => {
    if (!hasSearch) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hasSearch])

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
              {search && <LabSearchBox {...search} inputRef={searchRef} />}
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
          {/* Matches here, matches elsewhere: the corpora don't overlap, so "8 of 25" is only
              half the answer to "where is the thing I typed". */}
          {search && search.matched > 0 && elsewhere.length > 0 && (
            <ElsewhereLine q={search.state.q} places={elsewhere} lead="also in" />
          )}
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
          <LabDarkContext.Provider value={ui.dark}>
            {search && search.state.active && search.matched === 0 && search.total > 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted">
                No {search.noun ?? 'case'} matches{' '}
                <b className="text-ink">“{search.state.q}”</b> in this corpus.{' '}
                <button
                  type="button"
                  onClick={() => search.state.setQuery('')}
                  className="text-accent underline-offset-2 hover:underline"
                >
                  Clear the search
                </button>{' '}
                to get all {search.total} back.
                {elsewhere.length > 0 && (
                  <div className="mt-3 flex justify-center">
                    <ElsewhereLine q={search.state.q} places={elsewhere} lead="Found in" />
                  </div>
                )}
              </div>
            )}
            {children}
          </LabDarkContext.Provider>
        </main>
      </div>
    </LabZoomContext.Provider>
  )
}

/**
 * "…also in Gallery 1 · Feature A/B — Gallery lane 1" — the other corpora this query hits.
 *
 * Each chip is a link that carries the query (`?q=`), so following it lands on the match rather
 * than on that lab's front page with the search to type again. Both halves of the name are shown
 * — the lab and the corpus within it — because "Logo corpus (scorable)" alone does not tell you
 * that getting there is a tab away.
 */
function ElsewhereLine({ q, places, lead }: { q: string; places: Elsewhere[]; lead: string }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.68rem] text-faint">
      <span>{lead}</span>
      {places.map(({ place, count }, i) => (
        <span key={place.id} className="whitespace-nowrap">
          {i > 0 && <span className="mr-1.5 text-line-strong">·</span>}
          <Link
            to={place.href(q)}
            className="rounded px-1 py-0.5 text-ink-2 transition-colors hover:bg-surface-3 hover:text-accent"
          >
            {place.lab}
            {place.corpus && <span className="text-faint"> — {place.corpus}</span>}{' '}
            <b className="tabular-nums text-ink">{count}</b>
          </Link>
        </span>
      ))}
    </div>
  )
}

/**
 * The corpus search box. It filters the case LIST (see {@link useLabSearch}), so the counter
 * beside it reads against the whole corpus — `12/231` means twelve of the 231 cases will be
 * traced, not twelve of whatever this page happened to have already drawn.
 *
 * It is rendered by {@link LabPage} rather than passed in through `controls`, so it sits in
 * the same place, and answers to the same `/`, in every lab.
 */
function LabSearchBox({
  state,
  matched,
  total,
  noun = 'case',
  inputRef,
}: LabSearchProps & { inputRef: RefObject<HTMLInputElement | null> }) {
  return (
    <Tooltip
      side="bottom"
      label={
        <>
          Filter the corpus by name — <b>before</b> anything is traced, so a match hiding on
          page 4 comes to you and the rest is never traced at all. Space-separated terms all
          have to match. Press <b>/</b> from anywhere on the page to jump here, <b>Esc</b> to
          clear.
        </>
      }
    >
      <div className="inline-flex items-center gap-1.5">
        {/* The icon + clear button are absolutely placed, so they need a wrapper that is exactly
            the FIELD — hanging them off a box that also contains the counter puts the ✕ on top
            of it. */}
        <div className="relative inline-flex items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-faint" />
          <input
            ref={inputRef}
            type="search"
            value={state.query}
            onChange={(e) => state.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              if (state.query) state.setQuery('')
              else e.currentTarget.blur()
            }}
            placeholder={`Search ${noun}s`}
            aria-label={`Search ${noun}s`}
            className="lab-search"
          />
          {state.query && (
            <button
              type="button"
              onClick={() => state.setQuery('')}
              aria-label="Clear search"
              className="absolute right-1 grid h-4 w-4 place-items-center rounded text-faint transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <X size={11} />
            </button>
          )}
        </div>
        {/* Only while the query bites — an idle "231/231" is a number nobody asked for. */}
        {state.active && (
          <span className="whitespace-nowrap tabular-nums text-[0.68rem] text-faint">
            {matched}/{total}
          </span>
        )}
      </div>
    </Tooltip>
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

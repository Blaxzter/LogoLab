import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search } from 'lucide-react'

/**
 * A self-styled dropdown — the app's answer to the native `<select>`, which renders
 * as an OS widget that ignores the theme entirely (white-on-dark, foreign font) and
 * turns `<optgroup>` into greyed-out pseudo-rows instead of section structure.
 *
 * Positioning and dismissal follow {@link Tooltip} / `LabPopover` / `SupportPopover`:
 * the list is portaled to <body> with fixed coordinates, because the labs' toolbar is
 * STICKY and every panel strip is `overflow-hidden` / `overflow-x-auto` — an in-flow
 * popup would be clipped by one of them. It closes on outside pointerdown, Escape,
 * resize, and on any scroll that isn't the list's own.
 *
 * Two-part options: `label` is the name, `note` the dimmed metadata that trails it
 * (a date, or `before-x → after-x`). The list right-aligns the note, so a column of
 * names stays readable instead of every row being one long run-on string.
 *
 * Accessibility — this replaces a native control, so it reimplements what that gave
 * for free: the trigger is a `combobox` owning a `listbox`, arrows/Home/End move the
 * active option (never landing on a group header), Enter commits, Escape closes
 * WITHOUT committing, and focus returns to the trigger on every close so keyboard
 * users are never dumped at the top of the document. Long lists get a filter box;
 * short ones get native-style typeahead.
 *
 * Naming follows {@link Tooltip}'s reasoning in reverse: a combobox SHOULD carry the
 * field's name, so pass `labelledBy` pointing at the visible label. The trigger's own
 * text is then read as the combobox's value, exactly as the native control behaved.
 */

/** Distance between the trigger and the list. */
const GAP = 4
/** Keep-off margin from the viewport edges. */
const EDGE = 8
/** Tallest the scrolling list may get before it scrolls internally. */
const MAX_H = 340
/** Widest the list may get before labels truncate. */
const MAX_W = 520
/** Below the trigger, we need at least this much room or we flip above it. */
const MIN_BELOW = 180
/** From this many options up, the list gets a filter box instead of typeahead. */
const FILTER_FROM = 10
/** Typeahead buffer lifetime, ms (matches the native select's feel). */
const TYPE_RESET = 700

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  /** Dimmed metadata trailing the label — a date, a `before → after` pair. */
  note?: string
  /** Puts the option in a titled section. Ungrouped options come first, in order. */
  group?: string
}

interface Section<T extends string | number> {
  name?: string
  options: SelectOption<T>[]
}

/** Ungrouped options first, then each group in the order its first option appears —
 *  so a caller controls the layout by list order alone (the `<optgroup>` contract). */
function sectionize<T extends string | number>(options: SelectOption<T>[]): Section<T>[] {
  const out: Section<T>[] = []
  const plain = options.filter((o) => !o.group)
  if (plain.length) out.push({ options: plain })
  const names: string[] = []
  for (const o of options) if (o.group && !names.includes(o.group)) names.push(o.group)
  for (const name of names) out.push({ name, options: options.filter((o) => o.group === name) })
  return out
}

const matches = (o: SelectOption<string | number>, q: string) =>
  `${o.label} ${o.note ?? ''} ${o.group ?? ''}`.toLowerCase().includes(q)

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  labelledBy,
  filterFrom = FILTER_FROM,
  className = '',
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (v: T) => void
  /** Id of the visible label element — becomes the combobox's accessible name. */
  labelledBy?: string
  /** Option count from which the list offers a filter box. */
  filterFrom?: number
  className?: string
}) {
  const uid = useId()
  const listId = `${uid}-list`
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null)
  const [maxH, setMaxH] = useState(MAX_H)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const typed = useRef({ buf: '', at: 0 })

  const selected = options.find((o) => String(o.value) === String(value))
  const filtering = options.length >= filterFrom

  // Sections drive the rendering; the flat list drives the keyboard, so the active
  // index can never land on a group header. Each section carries the flat index its
  // first option sits at, so the two views agree without counting during render.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    let at = 0
    return sectionize(options)
      .map((s) => ({ ...s, options: q ? s.options.filter((o) => matches(o, q)) : s.options }))
      .filter((s) => s.options.length > 0)
      .map((s) => {
        const from = at
        at += s.options.length
        return { ...s, from }
      })
  }, [options, query])
  const flat = useMemo(() => sections.flatMap((s) => s.options), [sections])

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) btnRef.current?.focus()
  }, [])

  const commit = useCallback(
    (o: SelectOption<T>) => {
      onChange(o.value)
      close()
    },
    [onChange, close],
  )

  /** Open with the current value active — `options` order isn't render order, so the
   *  starting index has to be found in the sectioned list the keyboard walks. */
  const start = useCallback(() => {
    const i = sectionize(options)
      .flatMap((s) => s.options)
      .findIndex((o) => String(o.value) === String(value))
    setActive(Math.max(0, i))
    setQuery('')
    setOpen(true)
  }, [options, value])

  // Measure the trigger, then clamp the list inside the viewport. useLayoutEffect runs
  // before paint, so the list appears already placed (no (0,0) flash). Re-runs on
  // `query` because filtering changes the height an above-flip has to be offset by,
  // and on `maxH` so a flipped list is re-placed once its height cap has settled
  // (the first pass measures it uncapped). Converges: `maxH` comes from the trigger's
  // rect, not the list's own height.
  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    const pop = popRef.current
    if (!b) return
    const below = window.innerHeight - b.bottom - GAP - EDGE
    const above = b.top - GAP - EDGE
    const flip = below < MIN_BELOW && above > below
    const room = Math.max(120, Math.min(MAX_H, flip ? above : below))
    setMaxH(room)
    const w = pop?.offsetWidth ?? b.width
    const left = Math.max(EDGE, Math.min(b.left, window.innerWidth - w - EDGE))
    const h = pop?.offsetHeight ?? 0
    setPos({ left, top: flip ? Math.max(EDGE, b.top - GAP - h) : b.bottom + GAP, minWidth: b.width })
  }, [open, query, maxH])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      close(false)
    }
    // Capture-phase, like the other popovers — but a scroll INSIDE the list is the
    // user reading it, not the page moving beneath a fixed element.
    const onScroll = (e: Event) => {
      const t = e.target
      if (t instanceof Node && popRef.current?.contains(t)) return
      close(false)
    }
    const onResize = () => close(false)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, close])

  // Focus the filter box on open so typing goes somewhere sensible. Without one,
  // focus stays on the trigger and it keeps handling the keys itself.
  useEffect(() => {
    if (open && filtering) inputRef.current?.focus()
  }, [open, filtering])

  // Keep the active option in view — including the one restored on open.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // A filter that empties the list would strand the active index past the end.
  useEffect(() => {
    setActive((a) => (flat.length === 0 ? 0 : Math.min(a, flat.length - 1)))
  }, [flat.length])

  const typeahead = (ch: string) => {
    const now = performance.now()
    const buf = now - typed.current.at > TYPE_RESET ? ch : typed.current.buf + ch
    typed.current = { buf, at: now }
    const q = buf.toLowerCase()
    // Same-letter repeats cycle through the matches, as the native control does.
    const from = buf.length === 1 ? active + 1 : active
    const n = flat.length
    for (let k = 0; k < n; k++) {
      const i = (from + k + n) % n
      if (flat[i].label.toLowerCase().startsWith(q)) return setActive(i)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        return start()
      }
      // Printable key on a closed trigger opens and seeds, like the native control.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        start()
        if (filtering) setQuery(e.key)
        else typeahead(e.key)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        return setActive((a) => Math.min(a + 1, flat.length - 1))
      case 'ArrowUp':
        e.preventDefault()
        return setActive((a) => Math.max(a - 1, 0))
      case 'Home':
        e.preventDefault()
        return setActive(0)
      case 'End':
        e.preventDefault()
        return setActive(Math.max(0, flat.length - 1))
      case 'PageDown':
        e.preventDefault()
        return setActive((a) => Math.min(a + 8, flat.length - 1))
      case 'PageUp':
        e.preventDefault()
        return setActive((a) => Math.max(a - 8, 0))
      case 'Enter':
        e.preventDefault()
        if (flat[active]) commit(flat[active])
        return
      case ' ':
        // In the filter box a space is a space; only the typeahead list commits on it.
        if (filtering) return
        e.preventDefault()
        if (flat[active]) commit(flat[active])
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        return close()
      case 'Tab':
        // Move focus to the trigger and let the default Tab carry on FROM there, so
        // the sequence continues at the toolbar rather than at the portal in <body>.
        btnRef.current?.focus()
        setOpen(false)
        setQuery('')
        return
      default:
        if (!filtering && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          typeahead(e.key)
        }
    }
  }

  const activeId = open && flat[active] ? `${uid}-o${active}` : undefined

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelledBy}
        aria-activedescendant={filtering ? undefined : activeId}
        onClick={() => (open ? close() : start())}
        onKeyDown={onKeyDown}
        className={`inline-flex h-7 max-w-[22rem] items-center gap-1.5 rounded-md border bg-surface px-2 text-xs text-ink transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          open ? 'border-accent' : 'border-line-strong'
        } ${className}`}
      >
        <span className="min-w-0 truncate">{selected?.label ?? '—'}</span>
        {selected?.note && (
          <span className="min-w-0 shrink truncate text-faint">{selected.note}</span>
        )}
        <ChevronDown
          size={13}
          className={`ml-auto shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            className="animate-in-fade fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-lg"
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              minWidth: pos?.minWidth,
              maxWidth: Math.min(MAX_W, window.innerWidth - 2 * EDGE),
              visibility: pos ? 'visible' : 'hidden',
            }}
          >
            {filtering && (
              <div className="flex items-center gap-1.5 border-b border-line px-2">
                <Search size={12} className="shrink-0 text-faint" />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={onKeyDown}
                  aria-label="Filter options"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Filter…"
                  className="h-8 w-full min-w-0 bg-transparent text-xs text-ink placeholder:text-faint focus:outline-none"
                />
              </div>
            )}

            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={labelledBy}
              className="overflow-y-auto overscroll-contain p-1"
              style={{ maxHeight: maxH }}
            >
              {sections.map((s, si) => {
                const body = s.options.map((o, j) => {
                  const at = s.from + j
                  const isSel = String(o.value) === String(value)
                  return (
                    <div
                      key={String(o.value)}
                      id={`${uid}-o${at}`}
                      data-i={at}
                      role="option"
                      aria-selected={isSel}
                      onPointerEnter={() => setActive(at)}
                      onClick={() => commit(o)}
                      className={`flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs ${
                        at === active ? 'bg-surface-3' : ''
                      } ${isSel ? 'font-medium text-accent' : 'text-ink'}`}
                    >
                      <Check
                        size={12}
                        className={`shrink-0 ${isSel ? 'opacity-100' : 'opacity-0'}`}
                      />
                      <span className="min-w-0 truncate">{o.label}</span>
                      {o.note && (
                        <span
                          className={`ml-auto shrink-0 pl-2 text-[0.68rem] tabular-nums ${
                            isSel ? 'text-accent/70' : 'text-faint'
                          }`}
                        >
                          {o.note}
                        </span>
                      )}
                    </div>
                  )
                })
                return s.name ? (
                  <div
                    key={s.name}
                    role="group"
                    aria-label={s.name}
                    className={si > 0 ? 'mt-1 border-t border-line pt-1' : ''}
                  >
                    {/* The group's own aria-label carries this to a screen reader, so the
                        visible header is decoration — and a header is section STRUCTURE,
                        never a row you can land on. */}
                    <div
                      aria-hidden
                      className="px-1.5 pb-0.5 pt-1 text-[0.62rem] font-semibold uppercase tracking-wider text-faint"
                    >
                      {s.name}
                    </div>
                    {body}
                  </div>
                ) : (
                  <div key={`plain-${si}`}>{body}</div>
                )
              })}
              {flat.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted">No match</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

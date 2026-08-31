import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * The labs' corpus filter — "show me `gear`", typed, in any lab.
 *
 * It filters the CASE LIST, not the rendered rows. That distinction is the whole point: the
 * Workbench's "All tiers" is 231 cases across 8 pages and the A/B lab traces every case ×8
 * variants, so a filter that only hid finished rows would still make you page to where the
 * case lives and still pay for tracing everything else. Filtering the corpus means the run
 * itself shrinks to what you asked for — one case is one trace away, whatever page it was on.
 *
 * Which is also why the query SETTLES before it bites: a per-keystroke value would cancel and
 * restart the run five times per word (useLabRun re-runs whenever its deps change). Type at
 * speed, pay for one run.
 *
 * Deliberately NOT persisted (unlike everything else in useLabState): reopening a lab to a
 * corpus mysteriously filtered down to three cases by a search you typed last week is a bug
 * report, not a convenience. It does live in the URL as `?q=`, which is the opposite thing —
 * not state that follows you around, but a link that says what to look at. That is what makes
 * "your case is in the Gallery" (see corpusIndex.ts) a place you can click through to.
 */

/** How long typing settles before the corpus is re-filtered — long enough that a word costs
 *  one run, short enough that it still feels like the list is following you. */
const SETTLE_MS = 220

export interface LabSearchState {
  /** What's in the box right now. Updates per keystroke — it drives the input, nothing else. */
  query: string
  setQuery: (v: string) => void
  /** The SETTLED query, i.e. the one the filtering (and therefore the run) uses. */
  q: string
  /** A settled, non-empty query: the corpus on screen is a subset. */
  active: boolean
  /**
   * Does a case match? Case-insensitive, AND over whitespace-separated terms, each of which
   * may be a substring of ANY of the fields given ("gear 512" matches a case whose name has
   * `gear` and whose note has `512`). Pass everything the case is known BY — name, note, id.
   *
   * Stable while the settled query is: memoize a filtered corpus on `search.match` and it
   * keeps its identity across renders, which is what keeps useLabRun from re-running.
   */
  match: (...fields: (string | number | undefined | null | false)[]) => boolean
}

/**
 * @param onQuery Called when the box's text changes — labs that PAGE their corpus use it to
 *                jump back to page 1, since the match you searched for is otherwise likely to
 *                be on a page you are not looking at.
 */
export function useLabSearch(onQuery?: () => void): LabSearchState {
  const [params, setParams] = useSearchParams()
  // Seeded ONCE, from the link that opened the page — thereafter the box owns the value, so
  // clearing it is not undone by the `?q=` still sitting in the URL.
  const [query, setQuery] = useState(() => params.get('q') ?? '')
  const [q, setQ] = useState(query)

  const cb = useRef(onQuery)
  cb.current = onQuery

  const set = useCallback((v: string) => {
    setQuery(v)
    cb.current?.()
  }, [])

  useEffect(() => {
    if (query === q) return
    const t = setTimeout(() => setQ(query), SETTLE_MS)
    return () => clearTimeout(t)
  }, [query, q])

  // Publish the SETTLED query back, so what you're looking at is what you'd send someone. Once
  // per settle, never per keystroke, and `replace` so a typed word is not eight history entries.
  // Guarded on the URL already agreeing: `setParams` navigates, which re-renders this hook, and
  // an unguarded write would chase its own tail.
  useEffect(() => {
    if ((params.get('q') ?? '') === q) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (q) next.set('q', q)
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }, [q, params, setParams])

  const terms = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q])

  const match = useCallback(
    (...fields: (string | number | undefined | null | false)[]): boolean => {
      if (terms.length === 0) return true
      const hay = fields
        .filter((f): f is string | number => f != null && f !== false && f !== '')
        .join(' ')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    },
    [terms],
  )

  return { query, setQuery: set, q, active: terms.length > 0, match }
}

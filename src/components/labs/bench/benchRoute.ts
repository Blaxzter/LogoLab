// /labs/bench's address — pure, so the rules a test checks are the ones the page follows.
//
// The TAB is the path (/labs/bench/results), WHAT is on screen is the query (?corpus=,
// ?run=, the case search ?q=, Compare's ?a=&b=, Run's ?other=), and HOW it is drawn (box
// size, metric, ablations, sort) stays in localStorage. Until 2026-11-17 all of it lived in
// localStorage: no tab or case could be linked, Back left the page instead of the tab, and
// /labs/bench opened whatever tab you had last, so two people at the same URL could be
// looking at two different leaderboards.

export const BENCH_BASE = '/labs/bench'

/** In tab order. Overview is the bare path; every other tab is one segment under it. */
export const BENCH_TABS = ['overview', 'results', 'compare', 'cases', 'data', 'run'] as const
export type BenchTab = (typeof BENCH_TABS)[number]

/** The tabs that have a path segment of their own (scripts/routePages.ts writes a page for each). */
export const BENCH_SUBPATHS: readonly string[] = BENCH_TABS.filter((t) => t !== 'overview')

/** The tab the path segment after /labs/bench names: none is Overview, an unknown one is null. */
export function tabFromSegment(segment: string | undefined): BenchTab | null {
  if (!segment) return 'overview'
  return BENCH_SUBPATHS.includes(segment) ? (segment as BenchTab) : null
}

export function benchPath(tab: BenchTab): string {
  return tab === 'overview' ? BENCH_BASE : `${BENCH_BASE}/${tab}`
}

/**
 * Query keys that belong to ONE tab: written on that tab's address and dropped on the way to
 * another, where they would mean nothing. Every other key (run, corpus, the case search, the
 * dev-only source/hub) carries across tabs, which is what keeps the corpus you picked on the
 * Overview's leaderboard the corpus Results opens on.
 */
export const TAB_PARAMS: Readonly<Partial<Record<BenchTab, readonly string[]>>> = {
  compare: ['a', 'b'],
  run: ['other'],
}

const TAB_KEYS = new Set(Object.values(TAB_PARAMS).flat())

/**
 * `prev` with each key in `patch` set, or removed when its value is empty or equals its
 * default. A plain address stays plain: the run and corpus a fresh visit would pick anyway are
 * not written, so a link only names what differs from what anyone would see.
 */
export function patchParams(
  prev: URLSearchParams,
  patch: Record<string, string | null | undefined>,
  defaults: Record<string, string | undefined> = {},
): URLSearchParams {
  const next = new URLSearchParams(prev)
  for (const [key, value] of Object.entries(patch)) {
    if (!value || value === defaults[key]) next.delete(key)
    else next.set(key, value)
  }
  return next
}

/** The address of `tab`: today's query minus the keys of other tabs, plus `tabValues`. */
export function benchHref(
  tab: BenchTab,
  current: URLSearchParams,
  tabValues: Record<string, string | null | undefined> = {},
): string {
  const next = new URLSearchParams(current)
  for (const key of TAB_KEYS) next.delete(key)
  const own = TAB_PARAMS[tab] ?? []
  const params = patchParams(next, Object.fromEntries(own.map((k) => [k, tabValues[k]])))
  const query = params.toString()
  return query ? `${benchPath(tab)}?${query}` : benchPath(tab)
}

/** The corpus to show: the one the address names if this list has it, else the list's first. */
export function pickCorpus(param: string | null, corpora: readonly string[]): string {
  return param && corpora.includes(param) ? param : (corpora[0] ?? '')
}

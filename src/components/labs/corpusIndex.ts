// WHERE A CASE LIVES — the index behind "…and 1 elsewhere".
//
// Each lab's search filters that lab's corpus, which is right (see useLabSearch: filtering the
// case LIST is what keeps a match from costing 231 traces) and, on its own, a dead end. The
// corpora do not overlap, so a name you can picture is very often simply not in the one you are
// looking at, and "No case matches “olympic”" is then a true statement that answers the wrong
// question. It reads as "we don't have it"; the truth is "not on this page".
//
// `olympic-rings.svg` is the worked example. It is in examples/logos/, so it is in the Gallery
// and in the A/B gallery lane — but it is STROKED, so svgGround refuses it (the visible boundary
// is the stroke outline, not the path geometry) and the Workbench's "Logo corpus (scorable)"
// correctly excludes it. Search it from the Workbench and every corpus there is honestly empty.
// This index is what lets that page say so and point at the two places it does exist.
//
// Every entry DERIVES its names from the module the lab itself renders from — CORPORA for the
// Workbench, LOGO_CORPUS for the Gallery, AB_CORPUS/AB_LOGO_CASES for A/B. Nothing is re-listed
// here, so a corpus cannot drift out from under the index.
//
// Not indexed: the Engine, Pipeline and Profiler lanes. Those are a fixed handful of demo
// fixtures, every one of which is also an A/B fixture — so the index is incomplete about which
// labs will show you `bloom`, and never wrong about whether `bloom` exists.

import { CORPORA } from './workbench/corpora'
import { LOGO_CORPUS, LOGO_CORPUS_AVAILABLE } from '../../devtest/logoCorpus'
import { AB_CORPUS, AB_LOGO_CASES } from '../../devtest/abCorpus'
import type { LabSearchState } from './useLabSearch'

/** One searchable corpus, somewhere in the labs. */
export interface CorpusPlace {
  /**
   * Stable identity of this exact spot — `workbench:tier0`, `gallery`, `ab:gallery`. A lab
   * passes its OWN id as `here` so the index never offers you the page you are standing on.
   */
  id: string
  /** The lab, as its tab is named. */
  lab: string
  /** The corpus WITHIN that lab, when the lab has more than one. */
  corpus?: string
  /** False when this build doesn't have the art (the logos were never fetched). An unavailable
   *  place is never offered: a link to a page that will be empty is worse than no link. */
  available: boolean
  /** Where to go, with the query carried along so the match is in front of you on arrival. */
  href(q: string): string
  /** Everything each case there is known BY, one row per case — the same fields the lab's own
   *  search passes to `match`, so "found elsewhere" and "found here" agree on what a hit is. */
  fields(): (string | undefined)[][]
}

const enc = (q: string): string => encodeURIComponent(q)

/** Filenames actually bundled, so the A/B gallery lane is indexed exactly as full as it renders:
 *  AbLab drops a mark named in abCorpus that the local corpus doesn't have, and an index that
 *  didn't would send you to a lane where your match isn't. */
const onDisk = new Set(LOGO_CORPUS.map((l) => l.file))

export const CORPUS_PLACES: CorpusPlace[] = [
  ...CORPORA.map(
    (c): CorpusPlace => ({
      id: `workbench:${c.id}`,
      lab: 'Workbench',
      corpus: c.label,
      available: c.available,
      href: (q) => `/labs/workbench?corpus=${c.id}&q=${enc(q)}`,
      // `note` is a ReactNode in general; only a plain string can honestly be substring-matched.
      fields: () =>
        c.cases().map((x) => [x.title, x.key, typeof x.note === 'string' ? x.note : undefined]),
    }),
  ),
  {
    id: 'gallery',
    lab: 'Gallery',
    available: LOGO_CORPUS_AVAILABLE,
    href: (q) => `/labs/gallery?q=${enc(q)}`,
    fields: () => LOGO_CORPUS.map((c) => [c.company, c.notes, c.file]),
  },
  {
    id: 'ab:fixtures',
    lab: 'Feature A/B',
    corpus: 'Fixtures',
    available: true,
    href: (q) => `/labs/ab?lane=fixtures&q=${enc(q)}`,
    fields: () => AB_CORPUS.map((c) => [c.name, c.id]),
  },
  {
    id: 'ab:gallery',
    lab: 'Feature A/B',
    corpus: 'Gallery lane',
    available: LOGO_CORPUS_AVAILABLE,
    href: (q) => `/labs/ab?lane=gallery&q=${enc(q)}`,
    fields: () =>
      AB_LOGO_CASES.filter((c) => onDisk.has(c.path.split('/').pop()!)).map((c) => [c.name, c.id]),
  },
]

/** Case lists are static per place; a query re-runs, the list does not. (It matters for the
 *  Workbench's logo corpus, whose `cases()` triages 152 marks through the ground-truth reader.) */
const fieldCache = new Map<string, (string | undefined)[][]>()
const fieldsOf = (p: CorpusPlace): (string | undefined)[][] => {
  let f = fieldCache.get(p.id)
  if (!f) fieldCache.set(p.id, (f = p.fields()))
  return f
}

export interface Elsewhere {
  place: CorpusPlace
  count: number
}

/**
 * Every OTHER corpus the query hits, most matches first.
 *
 * @param match the caller's own `search.match` — so a place is reported as a hit under exactly
 *              the rule the page you land on will filter by.
 * @param here  the corpus (or corpora — A/B shows two lanes at once) being searched right now;
 *              never in the result, because "it is also here" is not news.
 */
export function searchElsewhere(
  match: LabSearchState['match'],
  here?: string | readonly string[],
): Elsewhere[] {
  const skip = new Set(here == null ? [] : typeof here === 'string' ? [here] : here)
  const out: Elsewhere[] = []
  for (const place of CORPUS_PLACES) {
    if (skip.has(place.id) || !place.available) continue
    let count = 0
    for (const row of fieldsOf(place)) if (match(...row)) count++
    if (count > 0) out.push({ place, count })
  }
  return out.sort((a, b) => b.count - a.count)
}

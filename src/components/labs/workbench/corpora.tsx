// The corpora — WHICH IMAGES. Every one of them is authored SVG, because the Workbench asks a
// single question of every case ("is the trace correct against the art that made the pixels?").
// A corpus only PRODUCES cases; it never scores, and it has no options — switching corpus changes
// the images and nothing else.
//
// The tier sets are flattened into this one list on purpose. They used to be a "Set" sub-selector
// next to a "Corpus" selector, which was two dropdowns for one idea. Tier 0 / 1 / 2 / Gated ARE
// different corpora — different art, different calibrated limits — so they're listed as such.
//
// Raster-only art (the golden fixtures, the eval PNGs) is deliberately absent: there is no authored
// vector to score it against. Those images are already in Feature A/B, which is where you compare
// them. Brand logos that svgGround can't read are in the Gallery.

import type { ReactNode } from 'react'
import { TRUTH_CORPUS, truthUrl, type TruthCase } from '../../../devtest/truthCorpus'
import { LOGO_CORPUS, LOGO_CORPUS_AVAILABLE, type LogoCase } from '../../../devtest/logoCorpus'
import { parseGroundTruth, unscorable } from '../../../devtest/svgGround'
import { NoteBox } from '../CaseRow'
import type { CorpusSource, WbCase } from './types'

// ---------------------------------------------------------------------------
// Ground truth — our handcrafted edge cases (tier 0) and the Fluent glyphs (tiers 1/2).
// ---------------------------------------------------------------------------

function truthWbCase(c: TruthCase): WbCase {
  return {
    key: c.name,
    title: c.name,
    note: c.note,
    tier: c.tier,
    gradients: c.gradients,
    flatSvg: c.flatSvg,
    load: async () => {
      const url = truthUrl(c)
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`source not served (HTTP ${resp.status} for ${url})`)
      return { svgText: await resp.text(), displayUrl: url }
    },
  }
}

/** One tier set, as a corpus. */
function truthSet(
  id: string,
  label: string,
  blurb: string,
  pick: (c: TruthCase) => boolean,
  hasFlatTwins = false,
): CorpusSource {
  return {
    id,
    label,
    available: true,
    blurb,
    hasFlatTwins,
    cases: () => TRUTH_CORPUS.filter(pick).map(truthWbCase),
  }
}

// ---------------------------------------------------------------------------
// Logo corpus — the scorable subset.
// ---------------------------------------------------------------------------

/**
 * The logos svgGround can actually read.
 *
 * A brand mark is only ground truth if its VISIBLE boundary is the boundary its path data
 * describes. Most aren't: strokes (the visible edge is the stroke outline, not the centerline),
 * filters, clips, masks and patterns all make the rendered silhouette something other than the
 * authored geometry — scoring those would produce a confident number measured against geometry the
 * renderer never drew. This is the same triage `vendorFluentEmoji.ts` runs (109 of 1595 candidates
 * survived it); applied here it turns ~150 brand marks into the subset that can honestly be an
 * answer sheet, which is what examples/logos/README.md claims the corpus is for. The rest are still
 * viewable in the Gallery — they're just not scored.
 *
 * Computed once, lazily: parseGroundTruth is a pure regex reader (no DOM), and the markup is
 * already bundled inline by logoCorpus's import.meta.glob, so no fetch and no round-trip.
 */
let scorableLogos: LogoCase[] | null = null
const getScorableLogos = (): LogoCase[] =>
  (scorableLogos ??= LOGO_CORPUS.filter((c) => !unscorable(parseGroundTruth(c.svg))))

/** Inline markup → something an <img> can display, without a fetch or a server. */
const svgDataUrl = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`

const logoEmptyState: ReactNode = (
  <div className="px-4 py-8">
    <NoteBox tone="warn">
      The logo corpus isn't present in this build. It's a private, git-ignored set of brand marks
      (not redistributed). Run <code>npm run fetch:logos</code> to download it into{' '}
      <code>examples/logos/</code>, then reload this page.
    </NoteBox>
  </div>
)

const logoCorpus: CorpusSource = {
  id: 'logos',
  label: 'Logo corpus (scorable)',
  available: LOGO_CORPUS_AVAILABLE,
  blurb:
    'The private brand-logo set, filtered to the marks whose visible boundary IS their path geometry — the ones that can honestly serve as an answer sheet. Stroked / filtered / clipped / masked marks are excluded (see them in the Gallery). Traced flat, and uncalibrated: no tier, so no pass/fail bars.',
  cases: () =>
    getScorableLogos().map(
      (c): WbCase => ({
        key: c.file,
        title: c.company,
        note: c.notes,
        // No tier: brand logos are not a calibrated population, so they get the numbers and no
        // gates. Borrowing tier 0's limits would print a verdict nobody measured.
        tier: undefined,
        // Flat: the product target is flat icons, and it's what the shipping config traces.
        gradients: false,
        load: async () => ({ svgText: c.svg, displayUrl: svgDataUrl(c.svg) }),
      }),
    ),
  emptyState: logoEmptyState,
}

// ---------------------------------------------------------------------------

export const CORPORA: CorpusSource[] = [
  truthSet(
    'tier0',
    'Tier 0 — handcrafted',
    'Our 16 handcrafted cases, each isolating a NAMED failure mode of this tracer. Calibrated on crisp flat art (chamfer 1.0px / p95 2.5px) — the strictest limits here.',
    (c) => c.tier === 0,
  ),
  truthSet(
    'tier1',
    'Tier 1 — Fluent gradients',
    'Microsoft Fluent Emoji "Color" (MIT): 109 authored multi-stop gradient glyphs, the only ground truth of its kind that exists. Its limits are "do not get worse" numbers, not "this is correct" numbers.',
    (c) => c.tier === 1,
    true,
  ),
  truthSet(
    'tier2',
    'Tier 2 — Fluent flat twins',
    'The same Fluent glyphs authored FLAT, scored in their own right. Flat multi-region art is what the product traces, and this is the tier where the zero-tolerance "regions recovered" gate actually runs.',
    (c) => c.tier === 2,
  ),
  truthSet(
    'gated',
    'Gated — what CI runs',
    'The subset test/truth-gate.test.ts actually enforces: all of tier 0 plus a small fixed slice of tier 1. A gate slow enough to be annoying gets switched off, and a gate that is off is not a gate.',
    (c) => c.gated ?? c.tier === 0,
    true,
  ),
  truthSet(
    'all',
    'All tiers',
    'Every ground-truth case: tier 0 + tier 1 + tier 2. 231 cases at 1–3s each, so page through it.',
    () => true,
    true,
  ),
  logoCorpus,
]

export const corpusById = (id: string): CorpusSource | undefined => CORPORA.find((c) => c.id === id)

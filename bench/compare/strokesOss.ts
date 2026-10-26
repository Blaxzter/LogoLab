// The STROKE-ICON corpus, `strokes-oss`: open-source icon sets that are AUTHORED as strokes,
// so the authored `d` is the centreline a centreline tracer has to find and `stroke-width`
// the width it has to measure (bench/lineArtGround.ts reads both). It is a 'line' corpus:
// scored by bench/centerlineScore.ts plus the pixel metrics, never mixed with the fill
// corpora's outline geometry (report.ts prints it in its own table).
//
// The sets, each pinned to an exact npm release (fetched by fetchStrokesOss.ts into
// .bench-tools/datasets/strokes-oss/, frozen in manifests/strokes-oss.json):
//
//   lucide    lucide-static 1.55.0 (ISC; a fork of Feather, MIT)   icons/*.svg
//   tabler    @tabler/icons 3.49.0, outline (MIT)                   icons/outline/*.svg
//   feather   feather-icons 4.29.2 (MIT)                            dist/icons/*.svg
//   phosphor  @phosphor-icons/core 2.1.1, regular (MIT)            DROPPED — see below
//
// Phosphor is fetched and CHECKED, then dropped: its regular weight ships every icon as
// filled outlines (`fill="currentColor"` paths, no stroke anywhere — the stroke is expanded
// to its outline before publishing), so there is no stroke to be the answer sheet, and
// inventing one (a skeleton of the fill) would score the tracers against our own guess.
// The fetch measures that rather than assuming it (`PHOSPHOR_DROP_FLOOR`), and the manifest
// records the counts.
//
// The sample is deterministic and balanced: within each set, icons are ranked by
// sha1(`<set>/<name>`) and the first SAMPLE_PER_SET ELIGIBLE ones are taken. Every icon
// passed over on the way is recorded in the manifest with its reason, so the exclusions are
// auditable and the sample is not quietly selected by scorability (the same discipline as
// fetch_svgbench.py's v0 cut). Exclusions (`classifyStrokeIcon`):
//
//   in-sample      a Lucide icon LogoLab's centreline engine was developed on (every
//                  public/examples/line-art/lucide-* and colour-line-art/cl-lucide-* fixture),
//                  or a Lucide alias with the same drawing, or Feather's drawing of one of
//                  them (Lucide forked Feather, and those twelve are near-copies).
//   duplicate      the same drawing as an icon earlier in the set's rank (aliases).
//   filled         an element both stroked and filled: the ink is a solid with a band round
//                  it, and the stroke's centreline is its boundary — not a line in the ink.
//   unread         a property the ground truth does not model (opacity, dashes, clip, mask,
//                  filter, `<use>`, `<text>`, `<image>`): scoring against it would score the
//                  reader.
//   no strokes     nothing stroked once dots are read as fills (lineArtGround.solidDot).
//
// The scoring resolution is the A/B line lane's: the flat cap (RASTER_MAX_DIM_FLAT, 2048),
// because the app traces an SVG source at that cap in mono, and a line-art trace at any
// other size is not what a user gets (bench/abCorpus.ts AB_LANES `line`).

import { createHash } from 'node:crypto'
import { parseLineArt } from '../lineArtGround.ts'

export type StrokeSetId = 'lucide' | 'tabler' | 'feather' | 'phosphor'

export interface StrokeSet {
  id: StrokeSetId
  /** npm package and the exact version pinned. */
  pkg: string
  version: string
  /** Directory inside the npm tarball holding the SVGs (trailing slash). */
  dir: string
  /** Licence file inside the tarball. */
  licenseFile: string
  license: string
  url: string
}

export const STROKE_SETS: StrokeSet[] = [
  {
    id: 'lucide',
    pkg: 'lucide-static',
    version: '1.55.0',
    dir: 'package/icons/',
    licenseFile: 'package/LICENSE',
    license: 'ISC (Lucide; portions MIT, Feather)',
    url: 'https://github.com/lucide-icons/lucide',
  },
  {
    id: 'tabler',
    pkg: '@tabler/icons',
    version: '3.49.0',
    dir: 'package/icons/outline/',
    licenseFile: 'package/LICENSE',
    license: 'MIT (Tabler Icons)',
    url: 'https://github.com/tabler/tabler-icons',
  },
  {
    id: 'feather',
    pkg: 'feather-icons',
    version: '4.29.2',
    dir: 'package/dist/icons/',
    licenseFile: 'package/LICENSE',
    license: 'MIT (Feather)',
    url: 'https://github.com/feathericons/feather',
  },
  {
    id: 'phosphor',
    pkg: '@phosphor-icons/core',
    version: '2.1.1',
    dir: 'package/assets/regular/',
    licenseFile: 'package/LICENSE',
    license: 'MIT (Phosphor Icons)',
    url: 'https://github.com/phosphor-icons/core',
  },
]

/** Icons per set in the sample: three sets × 67 ≈ 200. */
export const SAMPLE_PER_SET = 67

/** A set is dropped when at least this fraction of its icons has no stroke to score. */
export const PHOSPHOR_DROP_FLOOR = 0.95

/**
 * Feather names for in-sample Lucide icons Lucide RENAMED after the fork, so a same-name
 * check misses them. Lucide's `house` is Feather's `home`.
 */
export const FEATHER_NAME_OF: Record<string, string> = { house: 'home' }

/** The rank key: sha1 of `<set>/<name>`, hex. */
export const rankKey = (set: string, name: string): string => createHash('sha1').update(`${set}/${name}`).digest('hex')

/**
 * The drawing, without what does not draw: comments, the root's class / size, whitespace.
 * Two files with the same body are the same icon under two names.
 */
export function drawingBody(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sclass\s*=\s*"[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(\/?>)\s*/g, '$1')
    .trim()
}

const SHAPE_EL = /<(path|circle|ellipse|rect|polygon|polyline|line)\b([^>]*)>/g
const UNREAD: [RegExp, string][] = [
  [/\b(?:stroke-|fill-)?opacity\s*[=:]/, 'opacity'],
  [/\bstroke-dash(?:array|offset)\s*[=:]/, 'dashes'],
  [/\bclip-path\s*[=:]|<\s*clipPath\b/, 'clip'],
  [/\bmask\s*[=:]|<\s*mask\b/, 'mask'],
  [/\bfilter\s*[=:]|<\s*filter\b/, 'filter'],
  [/<\s*use\b/, '<use>'],
  [/<\s*text\b/, '<text>'],
  [/<\s*image\b/, '<image>'],
]

/**
 * Why an icon cannot be in the corpus, or null when it can. Reads the file as the ground
 * truth will (parseLineArt), plus the attributes that reader does not model. The
 * stroked-and-filled test reads element attributes: in all three sets the stroke comes from
 * the root `<svg>` and an element opts out with `stroke="none"`.
 */
export function classifyStrokeIcon(svg: string): string | null {
  for (const [re, what] of UNREAD) if (re.test(svg)) return `unread: ${what}`
  for (const m of svg.matchAll(SHAPE_EL)) {
    const body = m[2]
    const fill = /\bfill\s*=\s*"([^"]*)"/.exec(body)?.[1]
    const stroke = /\bstroke\s*=\s*"([^"]*)"/.exec(body)?.[1]
    if (fill !== undefined && fill !== 'none' && stroke !== 'none')
      return 'filled: a stroked element is also filled — its centreline is a boundary, not a line'
  }
  const gt = parseLineArt(svg)
  if (gt.strokes.length === 0) return 'no strokes: nothing is stroked once dots are read as fills'
  return null
}

export interface StrokeCandidate {
  set: StrokeSetId
  name: string
  svg: string
}

export interface StrokeSample {
  picked: StrokeCandidate[]
  /** Every candidate passed over before the cut, in rank order, with why. */
  skipped: { set: StrokeSetId; name: string; reason: string }[]
  /** Reasons over the WHOLE set (not only the ranked-ahead part). */
  counts: Record<string, Record<string, number>>
}

/**
 * The deterministic sample. `inSample` names Lucide icons to exclude (and, through
 * FEATHER_NAME_OF and the same names, their Feather drawings); `inSampleBodies` are those
 * icons' Lucide drawings, so a Lucide alias of one is excluded too.
 */
export function sampleStrokeIcons(
  candidates: StrokeCandidate[],
  perSet: number,
  inSample: Set<string>,
  inSampleBodies: Set<string> = new Set(),
): StrokeSample {
  const featherInSample = new Set([...inSample].map((n) => FEATHER_NAME_OF[n] ?? n))
  const picked: StrokeCandidate[] = []
  const skipped: StrokeSample['skipped'] = []
  const counts: StrokeSample['counts'] = {}
  const sets = [...new Set(candidates.map((c) => c.set))]
  for (const set of sets) {
    const ranked = candidates
      .filter((c) => c.set === set)
      .map((c) => ({ c, k: rankKey(c.set, c.name) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map((r) => r.c)
    const seen = new Map<string, string>()
    const count: Record<string, number> = {}
    let taken = 0
    for (const c of ranked) {
      const body = drawingBody(c.svg)
      let reason: string | null = null
      if (set === 'lucide' && (inSample.has(c.name) || inSampleBodies.has(body)))
        reason = 'in-sample: a centreline development fixture (public/examples/*line-art/)'
      else if (set === 'feather' && featherInSample.has(c.name))
        reason = "in-sample: Feather's drawing of a Lucide development fixture"
      else if (seen.has(body)) reason = `duplicate: the same drawing as ${seen.get(body)}`
      else reason = classifyStrokeIcon(c.svg)
      if (!seen.has(body)) seen.set(body, c.name)
      const key = reason ? reason.split(':')[0] : 'eligible'
      count[key] = (count[key] ?? 0) + 1
      if (taken >= perSet) continue
      if (reason) skipped.push({ set, name: c.name, reason })
      else {
        picked.push(c)
        taken++
      }
    }
    counts[set] = count
  }
  return { picked, skipped, counts }
}

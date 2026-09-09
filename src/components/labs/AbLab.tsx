// Feature A/B — trace variants side by side on real logos.
//
// The corpus metrics tell you a number moved. They cannot tell you whether the picture got
// better. This lab traces every case with the planar engine under each VARIANT, side by side,
// under one camera PER ROW — so a change can be JUDGED VISUALLY (a band↔ring junction, a wedge
// crossing) at the same framing across every variant of a case at once.
//
// THREE modes:
//  • variants (default) — the same working-tree code, one planarFit flag apart per panel.
//  • VS SNAPSHOT — the working-tree DEFAULT trace against the output frozen by
//    `pnpm gen:absnapshot` at an earlier revision (test/ab-snapshots/). Both panels trace
//    the snapshot's OWN stored pixels, so the delta is code, never rasterizer — the input
//    contract lives in src/devtest/abCorpus.ts, which also owns the shared case list.
//  • SNAPSHOT vs SNAPSHOT — two frozen stamps against each other, nothing traced at all.
//    The workflow CLAUDE.md prescribes produces exactly this: freeze `before-x`, change the
//    tracer, freeze `after-x`. Those two are a SET, and until this mode existed the `after-`
//    half was inert — the view could only diff a stamp against the working tree, so the
//    comparison decayed the moment the tree moved on. Frozen-vs-frozen does not decay, and
//    it is also the only way to compare two revisions neither of which is checked out.
//
// Meant to STAY in the tree and grow with future features. To A/B a new feature: add a VARIANT
// with its `planarFit` override (index.ts merges it last), or add a CASE in abCorpus.ts — or
// just drop an image onto the page.

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Upload, X } from 'lucide-react'
import { labImageData, rasterizeSvgResvg } from './resvgRaster'
import { rgbaToUrl } from './raster'
import { heatColor, HEAT_BG } from './heat'
import { DEFAULT_VECTORIZE_OPTIONS } from '../../lib/trace'
import type { VectorizeOptions } from '../../types'
import type { EditableDoc } from '../../lib/path/types'
import type { PlanarFitOptions } from '../../lib/trace/planarFit'
import {
  AB_CORPUS,
  AB_LANES,
  AB_LOGO_CASES,
  abUrl,
  conventionalPartner,
  laneFiles,
  pairSlug,
  type AbLane,
  type AbLaneKey,
  type AbSnapshotManifest,
} from '../../devtest/abCorpus'
import { LOGO_CORPUS } from '../../devtest/logoCorpus'
import { fnv1a } from './engineFingerprint'
import { LabPage, LabCheck, LabSelect } from './LabPage'
import { Panel, RawArt } from './Panel'
import { CaseRow, PendingRow, NoteBox } from './CaseRow'
import { useLabState } from './useLabState'
import { useLabSearch } from './useLabSearch'
import { useLabRun } from './useLabRun'
import { labTrace } from './labTrace'
import { docStats, traceSvg } from './wire'
import { serializeDoc, parseSvg } from '../../lib/path/model'
import { parseGroundTruth, toRasterSpace, unscorable, type GroundShape } from '../../devtest/svgGround'
import { inventedCorners, makeVisibleAt } from '../../devtest/geomScore'

// The frozen comparison targets, bundled like GoldenLab's fixtures (they live outside
// public/, so fetching would 404 in a build). Each snapshot is a SUBDIR under
// test/ab-snapshots/; the globs tolerate none existing yet — the dropdown just shows
// "Live variants" until `pnpm gen:absnapshot` runs.
//
// DEV ONLY. A stamp is a LOCAL working artifact — gitignored, because it is regenerable from
// any revision and because the gallery lane traces trademarked marks that are not
// redistributed — so a build must not carry whoever-built-it's stamps. It also could not:
// eagerly inlined, a working set of them put this chunk at 29.2 MiB, past Cloudflare's 25 MiB
// per-asset limit. In a build the dropdown shows "Live variants" only, exactly what a fresh
// clone shows.
//
// The MANIFESTS load eagerly, their CONTENTS lazily. The index has to exist before the
// dropdown can be drawn, and it is small (46 stamps ≈ 480 kB); what those stamps hold is
// ~3 000 SVGs and ~1 500 PNGs, of which a session opens one stamp's worth. Eager, that was
// ~4 500 module requests on mount in dev; lazily, a row pulls exactly the two files it
// diffs. The loaders need no cache of their own — a module is fetched once per specifier
// and every later call gets the same instance back.
const NO_META: Record<string, string> = {}
const SNAP_META = import.meta.env.DEV
  ? (import.meta.glob('/test/ab-snapshots/*/manifest.json', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>)
  : NO_META

/** A snapshot file, fetched on demand: `?raw` gives the markup, `?url` gives the asset URL. */
type SnapLoader = Record<string, () => Promise<string>>
const NO_SNAPS: SnapLoader = {}
const SNAP_SVGS: SnapLoader = import.meta.env.DEV
  ? (import.meta.glob('/test/ab-snapshots/*/*.svg', { query: '?raw', import: 'default' }) as SnapLoader)
  : NO_SNAPS
const SNAP_PNGS: SnapLoader = import.meta.env.DEV
  ? (import.meta.glob('/test/ab-snapshots/*/*.png', { query: '?url', import: 'default' }) as SnapLoader)
  : NO_SNAPS

/** Lane keys as the words the badges use ('flat' is not what the panel is called). */
const laneLabels = (keys: AbLaneKey[] | undefined): string =>
  (keys ?? []).map((k) => AB_LANES.find((l) => l.key === k)?.label ?? k).join(' + ')

/** One file out of a stamp, or null when that stamp does not have it. */
function snapFile(map: SnapLoader, path: string): Promise<string> | null {
  const load = map[path]
  return load ? load() : null
}

interface SnapEntry {
  name: string
  manifest: AbSnapshotManifest
}

/** Every snapshot found under test/ab-snapshots/<name>/, newest first (the dropdown
 *  order). The subdir name is the identity; the manifest's own `name` mirrors it. The sort
 *  key is the full `createdAt` timestamp where a stamp has one, else its day — a day alone
 *  tied every stamp frozen that day and fell back to the NAME, so a same-day pair could
 *  list under an unrelated earlier one. Pairs (below) inherit this order. */
const stampedAt = (s: SnapEntry): string => s.manifest.createdAt ?? s.manifest.date
const SNAPSHOTS: SnapEntry[] = Object.entries(SNAP_META)
  .map(([path, raw]) => {
    // /test/ab-snapshots/<name>/manifest.json → <name>
    const name = path.split('/').slice(-2, -1)[0]
    return { name, manifest: JSON.parse(raw) as AbSnapshotManifest }
  })
  .sort((a, b) => (stampedAt(a) < stampedAt(b) ? 1 : stampedAt(a) > stampedAt(b) ? -1 : a.name.localeCompare(b.name)))

/** A before/after SET: two stamps of one change, offered as ONE dropdown entry that selects
 *  both sides. Sourced two ways and deduped — an explicit `pair` in the newer stamp's
 *  manifest (`--pair`), or the `before-x`/`after-x` naming convention. Only pairs whose BOTH
 *  halves are present on disk are listed; a lone `before-` stamp is just a baseline. */
interface SnapPair {
  base: SnapEntry
  head: SnapEntry
  label: string
}
const SNAP_PAIRS: SnapPair[] = (() => {
  const byName = new Map(SNAPSHOTS.map((s) => [s.name, s]))
  const out: SnapPair[] = []
  const seen = new Set<string>()
  const add = (base: SnapEntry | undefined, head: SnapEntry | undefined): void => {
    if (!base || !head || base.name === head.name) return
    const key = `${base.name}→${head.name}`
    if (seen.has(key)) return
    seen.add(key)
    // The shared slug when both follow the convention, else just both names.
    const slug = pairSlug(base.name)
    out.push({ base, head, label: pairSlug(head.name) === slug ? slug : `${base.name} → ${head.name}` })
  }
  // Explicit first, so an author's `--pair` wins the dedupe over a coincidental name match.
  for (const s of SNAPSHOTS) if (s.manifest.pair) add(byName.get(s.manifest.pair), s)
  for (const s of SNAPSHOTS) {
    if (!s.name.startsWith('before-')) continue
    add(s, byName.get(conventionalPartner(s.name)!))
  }
  return out
})()

/** One trace configuration rendered per case. `planarFit` overrides the fit tunables;
 *  `opts` overrides any other VectorizeOptions (e.g. backgroundGradient). */
interface Variant {
  name: string
  tone?: 'base' | 'shipped' | 'refine'
  planarFit?: Partial<PlanarFitOptions>
  opts?: Partial<VectorizeOptions>
}

const VARIANTS: Variant[] = [
  { name: 'Baseline', tone: 'base', planarFit: { arcSnap: false, refineJunctions: false } },
  { name: 'Arc-snap (shipped)', tone: 'shipped', planarFit: { arcSnap: true, refineJunctions: false } },
  { name: 'Sub-pixel + G¹', tone: 'refine', planarFit: { arcSnap: false, refineJunctions: true } },
  // The blanket 'Weld ≤3px' variants were REMOVED 2026-07-21: re-measured against
  // today's tracer they newly cross two tier-2 gates (peanuts, custard) AND degrade
  // their own target cases (bloom p95 0.41→0.63, overlap 0.41→0.46) — the §10.4
  // junction re-seat + evidence-gated converged-pair weld runs LATER in the pipeline
  // and handles crossings better; centroid-fusing first preempts it. §10.4 has the
  // numbers; planarWeld.ts survives as the §10.4 weld's contraction engine.
  {
    name: 'BG gradient',
    tone: 'refine',
    opts: { backgroundGradient: true },
    planarFit: { arcSnap: true, refineJunctions: false },
  },
  // §10.1 scale-relative snap ε. The pair below makes the thesis visible: turn the §9.8
  // corner-turn veto OFF and small squares round to blobs (`checker`, `scale-blind`); a
  // scale-relative ε alone puts the corners back, discriminating by SIZE, no turn test.
  // `Scale-ε (veto on)` is byte-identical to Arc-snap on most cases (its extra bite — a
  // sub-6px flat blob the veto is blind to — is a narrow population); default is OFF.
  { name: 'Veto off (§9.8 guard removed)', tone: 'base', planarFit: { arcSnap: true, cornerVeto: false } },
  { name: 'Veto off + scale-ε', tone: 'shipped', planarFit: { arcSnap: true, cornerVeto: false, localScaleK: 0.15 } },
  { name: 'Scale-ε (veto on)', tone: 'refine', planarFit: { arcSnap: true, localScaleK: 0.15 } },
]

// The variant SET is part of what the cache key must cover: ENGINE_HASH fingerprints the
// tracer + scoring source (src/lib, src/devtest) but NOT this file, so adding a column or
// retuning a flag here would otherwise serve a stale cached analysis (missing the new column,
// or the old localScaleK). Fold a hash of the variant definitions into the options key so any
// edit above invalidates just the AB variant cache.
const VARIANTS_HASH = fnv1a(JSON.stringify(VARIANTS))

const TONE: Record<string, string> = {
  base: 'text-muted',
  shipped: 'text-good',
  refine: 'text-warn',
}

interface AbCase {
  name: string
  src: string
  kind: 'png' | 'svg'
  /** abCorpus id — the key into the snapshot manifest (absent for dropped images). */
  id?: string
  /** Session-dropped images carry their File so they can be re-rasterized at a new size. */
  file?: File
  /** Gallery lane: the mark's markup, bundled by logoCorpus's glob (the files live
   *  outside public/, so there is no URL to fetch — same reason /labs/gallery inlines it). */
  text?: string
  /** Composite the raster on this colour (the gallery lane's white). */
  background?: string
}

// The case list is OWNED by src/devtest/abCorpus.ts — the same list the snapshot
// writer traces, so the two consumers cannot drift. The handcrafted ⟐ edge cases
// are authored as SVG (src/devtest/genEdgeCases.ts), so the raster switch
// re-rasterizes each at any size: same vector content, varying resolution.
const FIXTURES: AbCase[] = AB_CORPUS.map((c) => ({ id: c.id, name: c.name, kind: c.kind, src: abUrl(c.path) }))

// The GALLERY lane — the same brand marks /labs/gallery shows, so a tracer change can be
// judged on art someone recognizes and not only on fixtures that are already good enough.
// Their SVGs are gitignored and live outside public/, so they arrive as bundled markup via
// logoCorpus (dev-only, empty in any build that never ran `npm run fetch:logos`) and are
// rasterized on WHITE, matching the gallery. A mark in abCorpus but not on disk is dropped
// here rather than erroring — the lane is as full as the local corpus is.
const LOGO_SVG = new Map(LOGO_CORPUS.map((l) => [l.file, l.svg]))
const GALLERY: AbCase[] = AB_LOGO_CASES.flatMap((c) => {
  const text = LOGO_SVG.get(c.path.split('/').pop()!)
  if (!text) return []
  // A blob URL so the source panel and labImageData behave exactly like a fixture's.
  return [{ id: c.id, name: c.name, kind: 'svg' as const, src: svgBlobUrl(text), text, background: c.background }]
})

/** Bundled markup → an object URL the <img> panels can show. */
function svgBlobUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
}

/** Which lane(s) to run — the gallery lane doubles the corpus, and in variants mode every
 *  case costs VARIANTS.length traces, so it is switchable rather than always on. */
const LANES = [
  { value: 'all', label: 'Fixtures + gallery' },
  { value: 'fixtures', label: 'Fixtures only' },
  { value: 'gallery', label: 'Gallery only' },
]

/** Which corpusIndex places this lane IS, so "…also in" never offers a lane already on screen.
 *  Module-level and frozen per lane so the identity is stable across renders. */
const LANE_PLACES: Record<string, readonly string[]> = {
  all: ['ab:fixtures', 'ab:gallery'],
  fixtures: ['ab:fixtures'],
  gallery: ['ab:gallery'],
}

/** Rasterization sizes offered by the raster switch (SVG cases re-render at each; raster
 *  cases only downscale, so they cap at their native size). */
const RASTER_SIZES = [128, 256, 512, 768, 1024]

interface AbAnalysis {
  width: number
  height: number
  /** In snapshot mode the source panel must show the SNAPSHOT's pixels, not the live case URL. */
  srcOverride?: string
  /** Snapshot mode only: did the working tree's trace differ from the frozen one, in EITHER
   *  gradient setting? undefined in variants mode (no baseline). Drives "Changed only". */
  changed?: boolean
  /** …and which ones moved — the stamp froze every lane, so every lane is compared and the
   *  answer is a set, not a property of whatever happened to be on screen. */
  changedIn?: AbLaneKey[]
  /**
   * Which lane(s) the PANELS below actually show. Normally that is `changedIn`,
   * but a case that moved in neither falls back to the flat pair — so switching baselines can
   * silently switch which lane is on screen, and a lane switch looks exactly like a
   * regression. (Reported: `checker`'s gradient trace has been visibly warped since the
   * oldest stamp on disk, while its flat trace is pixel-perfect; comparing against two
   * different stamps showed flat in one and gradients in the other, and read as the working
   * tree having changed under the user.) Derived from the rendered views, not re-decided, so
   * the badge cannot drift from the panels.
   */
  shownLanes?: AbLaneKey[]
  /** Snapshot mode, changed cases only: a per-pixel heat of WHERE the two traces disagree.
   *  Lets a change be located, not just counted — one per lane on screen. */
  heats?: { label: string; url: string }[]
  /** Pair mode only: the two stamps did not trace the same INPUT for this case (the source
   *  art or AB_SNAPSHOT_RES changed between them), so their traces are not comparable and
   *  the row is excluded from the changed/unchanged counts. */
  inputDiffers?: string
  /** `note` overrides the panel's stats line for a panel that has no live doc to count
   *  (a frozen stamp) — in pair mode BOTH panels are frozen and each carries its own rev. */
  variants: {
    name: string
    tone?: string
    svg: string
    stats?: ReturnType<typeof docStats>
    note?: string
    /** §23's precision count for THIS panel's trace, when the case has authored geometry to
     *  score against. The one number this view carries that is not structural, and it earns
     *  the exception: a corner the art does not contain is the defect class this whole view
     *  exists to catch by eye (§22), and it is cheap to put it beside the picture. */
    invented?: number
  }[]
}

/**
 * The case's AUTHORED geometry in raster space, or null when there is none to score against
 * (a dropped PNG, a stroked SVG svgGround refuses, a fetch that fails). Gallery marks carry
 * their markup inline — their files live outside public/ and have no URL.
 */
async function authoredShapes(c: AbCase, width: number): Promise<GroundShape[] | null> {
  if (c.kind !== 'svg') return null
  try {
    const text = c.text ?? (await (await fetch(c.src)).text())
    const gt = parseGroundTruth(text)
    if (unscorable(gt)) return null
    return toRasterSpace(gt, width)
  } catch {
    return null
  }
}

/**
 * How many sharp corners a panel's trace asserts that the art does not have (§23). Works off
 * the SERIALIZED svg so both sides are read identically — the frozen stamp has no live doc,
 * and `serializeDoc`/`parseSvg` round-trip, so re-parsing is the honest way to put the two
 * revisions' numbers side by side rather than scoring one and estimating the other.
 */
function inventedIn(
  svg: string,
  gt: GroundShape[] | null,
  image: ImageData | null,
  w: number,
  h: number,
): number | undefined {
  if (!gt || !image) return undefined
  const doc = parseSvg(svg)
  if (!doc) return undefined
  const sets = doc.items.flatMap((it) => (it.kind === 'path' && it.visible !== false ? [it.subPaths] : []))
  if (!sets.length) return undefined
  try {
    return inventedCorners(gt, sets, w, h, makeVisibleAt(image)).count
  } catch {
    return undefined
  }
}

/**
 * ` · N inv` for a panel, and ` (+N)` against the panel it is being compared with. Panels come
 * in pairs (base, then shipped) per lane, so the partner is the even-indexed neighbour. The
 * delta is the whole point: 12 on its own says little, 12 → 18 is a rejected change.
 */
function inventedNote(variants: AbAnalysis['variants'], i: number): string {
  const v = variants[i]
  if (v.invented === undefined) return ''
  const partner = i % 2 === 1 ? variants[i - 1] : undefined
  const d = partner?.invented !== undefined ? v.invented - partner.invented : 0
  return ` · ${v.invented} inv${d !== 0 ? ` (${d > 0 ? '+' : ''}${d})` : ''}`
}

/** Full-scale (RGB euclidean distance) at which the diff heat saturates to its hottest. A
 *  clean fill swap (ink↔beige, ~250) pins hot; sub-pixel AA jitter stays cool. */
const HEAT_SCALE = 110

/** Per-pixel diff of two equal-size rasters → a heat RGBA buffer on HEAT_BG: hot where the
 *  traces disagree, the shared cold→hot ramp (heat.ts) so it reads like every other lab heat.
 *  Pure — no DOM — so the pixel math is testable headless; rgbaToUrl does the canvas encode. */
function diffHeatBuffer(a: ImageData, b: ImageData): Uint8ClampedArray {
  const n = a.width * a.height
  const out = new Uint8ClampedArray(n * 4)
  const bg = [10, 12, 22] // ~HEAT_BG, so cold pixels sit on the panel's own backdrop
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const dr = a.data[o] - b.data[o]
    const dg = a.data[o + 1] - b.data[o + 1]
    const db = a.data[o + 2] - b.data[o + 2]
    const t = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / HEAT_SCALE)
    if (t < 0.02) {
      out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255
      continue
    }
    const [hr, hg, hb] = heatColor(t)
    out[o] = hr; out[o + 1] = hg; out[o + 2] = hb; out[o + 3] = 255
  }
  return out
}

/** Fetch a snapshot's stored input PNG as bytes, for the pair-mode input check. */
async function snapPngBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * PAIR mode: two FROZEN stamps against each other. Nothing is traced — both sides are the
 * serialized docs the writer stored — so this is fast, and (unlike vs-working-tree) the
 * comparison does not decay as the tree moves on.
 *
 * The hazard it has to guard is INPUT DRIFT: two stamps can hold different pixels for the
 * same case id — the fixture SVG was edited, or a lane's resolution changed between them —
 * and diffing traces of different inputs is exactly the confounded measurement this lab
 * exists to prevent. Every lane's stored inputs are compared byte-for-byte; a mismatch marks
 * the row and keeps it out of the counts rather than quietly reporting the art change as a
 * code change. That check is also what makes a resolution bump safe: an old stamp paired
 * with a new one says "512×512 vs 2048×2048", it does not invent a verdict.
 */
async function analyzeSnapshotPair(c: AbCase, base: SnapEntry, head: SnapEntry): Promise<AbAnalysis> {
  const be = base.manifest.cases.find((s) => s.id === c.id)
  const he = head.manifest.cases.find((s) => s.id === c.id)
  if (!be || !he) throw new Error(`case missing from ${be ? head.name : base.name} — rerun pnpm gen:absnapshot`)
  const bDir = `/test/ab-snapshots/${base.name}`
  const hDir = `/test/ab-snapshots/${head.name}`

  // Same exact-serialization diff the vs-working-tree path uses: a stamp IS serializeDoc(doc)
  // at its revision and gradientId is deterministic, so identical geometry+paint serializes
  // byte-identically and any difference is a real trace change. A lane only one of the two
  // stamps carries (mono, against a stamp frozen before it existed) is skipped — there is no
  // pair to make of it.
  const view = async (lane: AbLane) => {
    const bf = laneFiles(be, lane.key)
    const hf = laneFiles(he, lane.key)
    if (!bf || !hf) return null
    const [bSvg, hSvg, bPng, hPng] = await Promise.all([
      snapFile(SNAP_SVGS, `${bDir}/${bf.svg}`),
      snapFile(SNAP_SVGS, `${hDir}/${hf.svg}`),
      snapFile(SNAP_PNGS, `${bDir}/${bf.png}`),
      snapFile(SNAP_PNGS, `${hDir}/${hf.png}`),
    ])
    if (!bSvg || !hSvg || !bPng || !hPng) return null
    let differs: string | undefined
    if (bf.width !== hf.width || bf.height !== hf.height) {
      differs = `${lane.label} ${bf.width}×${bf.height} vs ${hf.width}×${hf.height}`
    } else {
      const [bb, hb] = await Promise.all([snapPngBytes(bPng), snapPngBytes(hPng)])
      if (!sameBytes(bb, hb)) differs = `${lane.label}: same size, different pixels`
    }
    return { lane, bf, hf, bSvg, hSvg, bPng, differs, changed: bSvg !== hSvg }
  }
  const lanes = (await Promise.all(AB_LANES.map(view))).filter((v) => v != null)
  if (lanes.length === 0) throw new Error('snapshot files missing — rerun pnpm gen:absnapshot')

  // ONE mismatched lane poisons the row: the stamps do not describe the same experiment, and
  // saying which lane drifted is what tells you whether to re-stamp or to look again.
  const mismatched = lanes.filter((v) => v.differs)
  const inputDiffers = mismatched.length ? mismatched.map((v) => v.differs!).join(' · ') : undefined

  const views = lanes.filter((v) => v.changed)
  if (views.length === 0) views.push(lanes[0])
  const label = (v: { lane: AbLane }): string => ` · ${v.lane.label}`

  // Authored geometry is raster-space, so it is resolved per lane now that lanes differ.
  const variants: AbAnalysis['variants'] = []
  for (const v of views) {
    const gt = await authoredShapes(c, v.bf.width)
    const img = await labImageData(v.bPng, Math.max(v.bf.width, v.bf.height))
    const inv = (svg: string): number | undefined => inventedIn(svg, gt, img, v.bf.width, v.bf.height)
    variants.push(
      { name: `${base.name}${label(v)}`, tone: 'base', svg: v.bSvg, note: `frozen ${base.manifest.rev} · ${base.manifest.date}`, invented: inv(v.bSvg) },
      { name: `${head.name}${label(v)}`, tone: 'shipped', svg: v.hSvg, note: `frozen ${head.manifest.rev} · ${head.manifest.date}`, invented: inv(v.hSvg) },
    )
  }

  const heats = inputDiffers
    ? []
    : (
        await Promise.all(
          views.map(async (v) => {
            if (!v.changed) return null
            const [bImg, hImg] = await Promise.all([
              rasterizeSvgResvg(v.bSvg, v.bf.width, { background: 'white' }),
              rasterizeSvgResvg(v.hSvg, v.hf.width, { background: 'white' }),
            ])
            if (bImg.width !== hImg.width || bImg.height !== hImg.height) return null
            return { label: `diff heat${label(v)}`, url: rgbaToUrl(diffHeatBuffer(bImg, hImg), bImg.width, bImg.height) }
          }),
        )
      ).filter((h): h is { label: string; url: string } => h != null)

  const primary = lanes[0]
  const changedIn = lanes.filter((v) => v.changed).map((v) => v.lane.key)
  return {
    width: primary.bf.width,
    height: primary.bf.height,
    srcOverride: primary.bPng,
    // A row whose input moved has no meaningful verdict — leave `changed` undefined so it is
    // neither counted as changed nor claimed unchanged, and so "Changed only" keeps showing it.
    changed: inputDiffers ? undefined : changedIn.length > 0,
    changedIn: inputDiffers ? undefined : changedIn,
    shownLanes: views.map((v) => v.lane.key),
    heats,
    inputDiffers,
    variants,
  }
}

/** Vs-snapshot mode: trace the WORKING TREE's default config from the snapshot's own stored
 *  pixels and pair it with the stored trace — same input file, two code revisions. */
async function analyzeSnapshot(c: AbCase, snap: SnapEntry): Promise<AbAnalysis> {
  const entry = snap.manifest.cases.find((s) => s.id === c.id)
  if (!entry) throw new Error(`case not in snapshot ${snap.name} — rerun pnpm gen:absnapshot`)
  const dir = `/test/ab-snapshots/${snap.name}`

  // ONE PASS PER LANE THE STAMP CARRIES — a stamp freezes all of them, so all of them are
  // compared and each is a candidate for the row. Nothing here depends on a toggle: §14's
  // fix moved four FLAT traces and no gradient one, and a view whose verdict follows a
  // control is a view that can be read wrong. A lane the stamp predates (mono, on anything
  // frozen before it existed) resolves to null and is skipped rather than invented.
  //
  // Each lane traces its OWN stored raster at its OWN size, read from the manifest — never
  // from today's constants, which is what lets stamps frozen under one resolution rule
  // stay comparable after it changes.
  //
  // "Changed" is an exact-serialization diff: the snapshot IS serializeDoc(doc) at the
  // frozen rev (writeAbSnapshots.ts) and gradientId is deterministic, so identical
  // geometry+paint serializes byte-identically — a difference is a real trace change,
  // nothing cosmetic.
  const inputs = new Map<string, Promise<ImageData>>()
  const inputFor = (png: string, url: string, long: number): Promise<ImageData> => {
    const hit = inputs.get(png)
    if (hit) return hit
    const p = labImageData(url, long)
    inputs.set(png, p)
    return p
  }
  const pass = async (lane: AbLane) => {
    const f = laneFiles(entry, lane.key)
    if (!f) return null
    const [snapSvg, pngUrl] = await Promise.all([
      snapFile(SNAP_SVGS, `${dir}/${f.svg}`),
      snapFile(SNAP_PNGS, `${dir}/${f.png}`),
    ])
    if (!snapSvg || !pngUrl) return null
    const image = await inputFor(f.png, pngUrl, Math.max(f.width, f.height))
    const doc: EditableDoc = await labTrace(image, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      ...lane.opts,
      // Resolved from the SAME pixels the stamp resolved them from, so the two sides differ
      // by code and never by a lane parameter (see AbLane.resolve).
      ...lane.resolve?.(image),
    })
    const live = serializeDoc(doc, 2)
    return { lane, f, image, pngUrl, snapSvg, doc, live, changed: live !== snapSvg }
  }
  // Sequential: labTrace hands off to the trace worker, and three lanes racing for it would
  // only interleave, not finish sooner.
  const passes: NonNullable<Awaited<ReturnType<typeof pass>>>[] = []
  for (const lane of AB_LANES) {
    const p = await pass(lane)
    if (p) passes.push(p)
  }
  if (passes.length === 0) throw new Error('snapshot files missing — rerun pnpm gen:absnapshot')

  // WHAT IS ON SCREEN IS WHAT MOVED: every lane that changed gets its own snapshot /
  // working-tree pair and its own heat, in AB_LANES order so rows are comparable. A case
  // that moved in no lane shows the first one alone — there is nothing to locate, and
  // duplicating it for every quiet row is noise, not information.
  const views = passes.filter((v) => v.changed)
  if (views.length === 0) views.push(passes[0])
  const label = (v: { lane: AbLane }): string => ` · ${v.lane.label}`

  // Ground truth is raster-space, so it is per-LANE now that lanes can differ in size.
  const gtAt = new Map<number, Promise<GroundShape[] | null>>()
  const shapesFor = (width: number): Promise<GroundShape[] | null> => {
    const hit = gtAt.get(width)
    if (hit) return hit
    const p = authoredShapes(c, width)
    gtAt.set(width, p)
    return p
  }
  const variants: AbAnalysis['variants'] = []
  for (const v of views) {
    const gt = await shapesFor(v.f.width)
    const inv = (svg: string): number | undefined => inventedIn(svg, gt, v.image, v.f.width, v.f.height)
    variants.push(
      { name: `Snapshot @ ${snap.manifest.rev}${label(v)}`, tone: 'base', svg: v.snapSvg, invented: inv(v.snapSvg) },
      {
        name: `Working tree${label(v)}`,
        tone: 'shipped',
        svg: traceSvg(v.doc, v.f.width, v.f.height),
        stats: docStats(v.doc),
        invented: inv(v.live),
      },
    )
  }

  // Changed views also rasterize BOTH plain-fill traces (no wireframe) on white and heat their
  // per-pixel delta, so the diff is LOCATED. A quiet view has no heat: nothing to paint.
  const heats = (
    await Promise.all(
      views.map(async (v) => {
        if (!v.changed) return null
        const [snapImg, liveImg] = await Promise.all([
          rasterizeSvgResvg(v.snapSvg, v.f.width, { background: 'white' }),
          rasterizeSvgResvg(v.live, v.f.width, { background: 'white' }),
        ])
        if (snapImg.width !== liveImg.width || snapImg.height !== liveImg.height) return null
        return { label: `diff heat${label(v)}`, url: rgbaToUrl(diffHeatBuffer(snapImg, liveImg), snapImg.width, snapImg.height) }
      }),
    )
  ).filter((h): h is { label: string; url: string } => h != null)

  const primary = passes[0]
  return {
    width: primary.f.width,
    height: primary.f.height,
    srcOverride: primary.pngUrl,
    changed: passes.some((v) => v.changed),
    changedIn: passes.filter((v) => v.changed).map((v) => v.lane.key),
    shownLanes: views.map((v) => v.lane.key),
    heats,
    variants,
  }
}
async function analyze(c: AbCase, raster: number, gradients: boolean): Promise<AbAnalysis> {
  // Gallery cases carry their markup (c.text); fixtures are fetched from public/.
  const svgText = c.kind === 'svg' ? (c.text ?? (await (c.file ? c.file.text() : (await fetch(c.src)).text()))) : undefined
  const image = await labImageData(c.src, raster, svgText, c.background ? { background: c.background } : undefined)
  const w = image.width
  const h = image.height

  const variants: AbAnalysis['variants'] = []
  for (const v of VARIANTS) {
    const doc: EditableDoc = await labTrace(image, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients,
      ...v.opts,
      planarFit: v.planarFit,
    })
    variants.push({ name: v.name, tone: v.tone, svg: traceSvg(doc, w, h), stats: docStats(doc) })
  }
  return { width: w, height: h, variants }
}

export default function AbLab() {
  const [ui, setUi] = useLabState('lab:ab', {
    box: 300,
    gradients: false,
    raster: 512,
    wire: false,
    snapName: '',
    /** '' = the working tree; otherwise the snapshot the baseline is compared AGAINST. */
    vsName: '',
    changedOnly: false,
    lane: 'all',
  })
  // Dropped images live for the session only — their object URLs die on reload.
  const [extras, setExtras] = useState<AbCase[]>([])
  const [over, setOver] = useState(false)

  // The selected snapshot (or null in variants mode). An unknown name (a snapshot deleted since
  // it was last chosen) falls back to variants rather than erroring.
  const selectedSnap = SNAPSHOTS.find((s) => s.name === ui.snapName) ?? null
  const snapMode = selectedSnap != null
  // …and what it is compared against: the working tree (the default) or a SECOND stamp. A
  // stale/deleted name falls back to the working tree, same forgiving rule as the baseline.
  const vsSnap = snapMode ? (SNAPSHOTS.find((s) => s.name === ui.vsName && s.name !== selectedSnap.name) ?? null) : null
  const pairMode = vsSnap != null
  const changedOnly = snapMode && ui.changedOnly

  const search = useLabSearch()

  // `?lane=` — how a "your case is in the gallery lane" link arrives. The lane is otherwise
  // remembered per-user in useLabState, so a link that only carried `?q=` could land on
  // "Fixtures only" and show the empty state it was sent to disprove. The selector writes the
  // param back for the same reason `?q=` is republished: a URL that disagrees with the page is
  // a link that lies about what it will show.
  const [params, setParams] = useSearchParams()
  const laneParam = params.get('lane')
  useEffect(() => {
    if (laneParam && LANES.some((l) => l.value === laneParam)) setUi({ lane: laneParam })
  }, [laneParam, setUi])
  const selectLane = (lane: string) => {
    setUi({ lane })
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('lane', lane)
        return next
      },
      { replace: true },
    )
  }

  const lane = useMemo(
    () => [...(ui.lane === 'gallery' ? [] : FIXTURES), ...(ui.lane === 'fixtures' ? [] : GALLERY), ...extras],
    [extras, ui.lane],
  )
  // The search filters the CORPUS, not the rows on screen — in variants mode every case costs
  // VARIANTS.length traces, so narrowing to `gear` has to mean tracing gear, not tracing all of
  // them and hiding the rest. `Changed only` still applies on top, to whatever matched.
  const found = useMemo(() => lane.filter((c) => search.match(c.name, c.id)), [lane, search.match])
  // A snapshot frozen before a case existed (an older stamp, or one taken with a different
  // --logos slice) simply doesn't have it. Hide those rather than filling the page with
  // "case not in snapshot" errors — the count is reported in the summary line instead. In pair
  // mode BOTH stamps must have the case, for the same reason.
  const cases = useMemo(
    () =>
      selectedSnap
        ? found.filter(
            (c) =>
              !c.id ||
              (selectedSnap.manifest.cases.some((s) => s.id === c.id) && (!vsSnap || vsSnap.manifest.cases.some((s) => s.id === c.id))),
          )
        : found,
    [found, selectedSnap, vsSnap],
  )
  const notInSnap = found.length - cases.length

  const run = useLabRun(
    cases,
    (c) =>
      selectedSnap
        ? vsSnap
          ? analyzeSnapshotPair(c, selectedSnap, vsSnap)
          : analyzeSnapshot(c, selectedSnap)
        : analyze(c, ui.raster, ui.gradients),
    {
      label: (c) =>
        pairMode
          ? `Diffing ${c.name} — ${selectedSnap!.name} vs ${vsSnap!.name}`
          : snapMode
            ? `Tracing ${c.name} vs ${selectedSnap!.name}`
            : `Tracing ${c.name} × ${VARIANTS.length} variants`,
      done: (n) =>
        pairMode
          ? `Done — ${n} cases, snapshot ${selectedSnap!.name} @ ${selectedSnap!.manifest.rev} (${selectedSnap!.manifest.date}) vs ${vsSnap!.name} @ ${vsSnap!.manifest.rev} (${vsSnap!.manifest.date}) · both frozen, nothing traced, so the working tree cannot affect this comparison.`
          : selectedSnap
            ? `Done — ${n} cases, working tree vs snapshot ${selectedSnap.name} @ ${selectedSnap.manifest.rev} (${selectedSnap.manifest.date}) · every lane it carries compared, whichever moved is on screen · each lane pinned to its own stored pixels.`
            : `Done — ${n} cases × ${VARIANTS.length} variants · gradients ${ui.gradients ? 'on' : 'off'} @ ${ui.raster}px. Drop an image anywhere to add it.`,
      deps: [ui.raster, ui.gradients, cases, ui.snapName, ui.vsName],
      // Cache corpus cases (stable `id`); skip session-dropped images (no id). BOTH snapshot
      // names are in the key so switching either side (or re-blessing one) invalidates results —
      // the frozen SVGs live outside src/, so ENGINE_HASH alone wouldn't catch a re-bless.
      cache: {
        id: 'ab',
        key: (c) => c.id ?? null,
        optionsKey: selectedSnap
          ? vsSnap
            ? `pair:v1:${selectedSnap.name}:${vsSnap.name}`
            : `snap:v5:${selectedSnap.name}`
          : `var:r${ui.raster}:g${ui.gradients}:v${VARIANTS_HASH}`,
      },
    },
  )

  const addFile = (f: File) => {
    if (!f.type.startsWith('image/')) return
    setExtras((prev) => [
      ...prev,
      { name: f.name, src: URL.createObjectURL(f), kind: f.type.includes('svg') ? 'svg' : 'png', file: f },
    ])
  }

  // "Changed only" hides cases that serialize identically to the snapshot in BOTH gradient
  // settings. Errors (value null) and still-resolving rows are kept — only a confirmed
  // match in both is hidden.
  const shown = changedOnly ? run.results.filter((r) => r.value?.changed !== false) : run.results
  const changedN = run.results.filter((r) => r.value?.changed === true).length
  // Per-LANE counts, derived from AB_LANES so a lane added there shows up here without a
  // second edit — the summary line used to name flat and gradients by hand.
  const laneN = AB_LANES.map((l) => ({
    lane: l,
    n: run.results.filter((r) => r.value?.changedIn?.includes(l.key)).length,
  })).filter((x) => x.n > 0)
  const unchangedN = run.results.filter((r) => r.value?.changed === false).length
  const mismatchN = run.results.filter((r) => r.value?.inputDiffers != null).length

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const f = e.dataTransfer.files?.[0]
        if (f) addFile(f)
      }}
      className={over ? 'ring-2 ring-inset ring-accent' : ''}
    >
      <LabPage
        storageKey="lab:ab"
        title="Feature A/B"
        subtitle="Trace variants side by side, one camera per row, nodes/edges overlay"
        status={run.status}
        running={run.running}
        progress={run.progress}
        box={ui.box}
        onBox={(box) => setUi({ box })}
        wires={ui.wire}
        search={{ state: search, matched: found.length, total: lane.length, here: LANE_PLACES[ui.lane] }}
        controls={
          <>
            {SNAPSHOTS.length > 0 && (
              // One control, three destinations. A PAIR entry sets both sides at once — that
              // is the whole "two stamps are a set" affordance — and the second select below
              // then shows what it resolved to, so nothing is hidden behind the shortcut.
              <LabSelect
                label="Baseline"
                value={ui.snapName === '' ? '' : `s:${ui.snapName}`}
                onChange={(v) => {
                  if (v === '') return setUi({ snapName: '', vsName: '' })
                  if (v.startsWith('p:')) {
                    const p = SNAP_PAIRS[Number(v.slice(2))]
                    return setUi({ snapName: p.base.name, vsName: p.head.name })
                  }
                  setUi({ snapName: v.slice(2), vsName: '' })
                }}
                options={[
                  { value: '', label: 'Live variants' },
                  ...SNAP_PAIRS.map((p, i) => ({
                    value: `p:${i}`,
                    // `label` is the shared slug when both names follow the convention, and
                    // already spells out both when they don't — in which case the name IS
                    // the pair, and there is no separate note to hang beside it.
                    label: p.label,
                    note: p.label.includes('→') ? undefined : `${p.base.name} → ${p.head.name}`,
                    group: '⇄ Pairs (both stamps frozen)',
                  })),
                  ...SNAPSHOTS.map((s) => ({
                    value: `s:${s.name}`,
                    label: s.name,
                    note: s.manifest.date,
                    group: 'Snapshots',
                  })),
                ]}
              />
            )}
            {snapMode && (
              <LabSelect
                label="Compare with"
                value={ui.vsName}
                onChange={(vsName) => setUi({ vsName })}
                options={[
                  { value: '', label: 'Working tree' },
                  ...SNAPSHOTS.filter((s) => s.name !== selectedSnap!.name).map((s) => ({
                    value: s.name,
                    label: s.name,
                    note: s.manifest.date,
                    group: 'Snapshots (frozen vs frozen)',
                  })),
                ]}
              />
            )}
            {snapMode && (
              <LabCheck
                label="Changed only"
                checked={ui.changedOnly}
                onChange={(changedOnly) => setUi({ changedOnly })}
              />
            )}
            <LabSelect
              label="Cases"
              value={ui.lane}
              onChange={selectLane}
              options={LANES.map((l) => ({
                value: l.value,
                // An unfetched logo corpus is a fact worth showing, not an empty list.
                label: l.value !== 'fixtures' && GALLERY.length === 0 ? `${l.label} (no logos — npm run fetch:logos)` : l.label,
              }))}
            />
            {/* Variants mode only. In snapshot mode the stamp holds BOTH traces per case and the
                row shows whichever moved, so there is nothing left for a gradient toggle to
                decide — and a control that only reorders panels is a control that reads like it
                filters them. (Input px is hidden there for the same reason: the input is pinned
                to the stamp's stored pixels.) */}
            {!snapMode && (
              <LabCheck
                label="Gradients"
                checked={ui.gradients}
                onChange={(gradients) => setUi({ gradients })}
              />
            )}
            {!snapMode && (
              <LabSelect
                label="Input px"
                value={ui.raster}
                onChange={(raster) => setUi({ raster })}
                options={RASTER_SIZES.map((s) => ({ value: s, label: `${s}px` }))}
              />
            )}
            <LabCheck label="Nodes/edges" checked={ui.wire} onChange={(wire) => setUi({ wire })} />
            <label className="btn btn-secondary h-7 cursor-pointer gap-1.5 px-2 text-xs">
              <Upload size={13} />
              Add image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) addFile(f)
                  e.target.value = ''
                }}
              />
            </label>
          </>
        }
        about={<AbAbout />}
      >
        {snapMode && (changedN > 0 || unchangedN > 0) && (
          // px-4 to sit on the same left edge as every CaseRow below it.
          <div className="px-4 pt-3 text-xs text-muted">
            <b className="text-fg">{changedN}</b> changed
            {changedN > 0 && (
              <span className="text-muted">
                {' '}
                ({laneN.map((x) => `${x.n} ${x.lane.label}`).join(' · ')})
              </span>
            )}{' '}
            · {unchangedN} unchanged
            {pairMode ? (
              <>
                {' '}
                · {selectedSnap!.name} @ {selectedSnap!.manifest.rev} <b className="text-fg">→</b> {vsSnap!.name} @{' '}
                {vsSnap!.manifest.rev}
              </>
            ) : (
              <>
                {' '}
                vs snapshot {selectedSnap!.name} @ {selectedSnap!.manifest.rev}
              </>
            )}
            {changedOnly && unchangedN > 0 && <span className="text-faint"> · {unchangedN} hidden</span>}
            {mismatchN > 0 && (
              <span className="text-bad">
                {' '}
                · {mismatchN} not comparable (the two stamps traced different input pixels — re-stamp both)
              </span>
            )}
            {changedN === 0 && unchangedN > 0 && (
              <span className="text-good">
                {' '}
                — {pairMode ? 'the two stamps agree' : 'working tree matches the snapshot'}, every lane
              </span>
            )}
            {notInSnap > 0 && (
              <span className="text-faint">
                {' '}
                · {notInSnap} case{notInSnap === 1 ? '' : 's'} not in this stamp (re-run{' '}
                <code>pnpm gen:absnapshot {selectedSnap!.name}</code> to include them)
              </span>
            )}
          </div>
        )}
        {shown.map(({ case: c, value: a, error }) => {
          if (!a) {
            return (
              <CaseRow key={c.name} title={c.name}>
                <NoteBox tone="bad">Failed to trace: {error}</NoteBox>
              </CaseRow>
            )
          }
          return (
            <CaseRow
              key={c.name}
              title={c.name}
              badges={
                <>
                  {a.inputDiffers && (
                    // The one verdict this view must never fake: two stamps that traced
                    // different pixels cannot say anything about the CODE between them.
                    <span className="rounded bg-bad/20 px-1 py-0.5 text-[0.6rem] text-bad">
                      input differs · {a.inputDiffers}
                    </span>
                  )}
                  {snapMode && a.changed != null && (
                    // WHICH settings moved, not "did the one on screen move" — and, always,
                    // which lane the panels below are. For a changed case those are the same
                    // set; for an UNCHANGED one the view falls back to the flat pair, and
                    // saying so is what stops a silent lane switch between two baselines from
                    // reading as a regression (see AbAnalysis.shownLanes).
                    <span
                      className={`rounded px-1 py-0.5 text-[0.6rem] ${a.changed ? 'bg-warn/20 text-warn' : 'text-faint'}`}
                    >
                      {a.changed ? `changed · ${laneLabels(a.changedIn)}` : `unchanged · showing ${laneLabels(a.shownLanes) || 'gradients off'}`}
                    </span>
                  )}
                  {c.file && (
                    <button
                      type="button"
                      onClick={() => setExtras((prev) => prev.filter((e) => e !== c))}
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.6rem] text-faint transition-colors hover:bg-surface-3 hover:text-bad"
                    >
                      <X size={10} />
                      remove
                    </button>
                  )}
                </>
              }
              right={`${a.width}×${a.height}`}
            >
              <Panel
                label="source"
                note={a.srcOverride ? `snapshot input · ${a.width}×${a.height}` : `${a.width}×${a.height}`}
                aspect={a.width / a.height}
                // Raster sources zoom as their ACTUAL pixels (the traces are vectors and stay
                // crisp regardless): browser bilinear upscale would show a soft blur that reads
                // as detail the tracer never saw. In snapshot mode the source is ALWAYS the
                // stored input PNG — the very pixels both revisions traced.
                pixelated={a.srcOverride != null || c.kind === 'png'}
                grid={{ w: a.width, h: a.height }}
              >
                <img src={a.srcOverride ?? c.src} alt="" />
              </Panel>
              {a.variants.map((v, vi) => (
                <Panel
                  key={v.name}
                  label={<span className={v.tone ? TONE[v.tone] : undefined}>{v.name}</span>}
                  note={
                    (v.stats
                      ? `${v.stats.paths}p · ${v.stats.nodes}n · ${v.stats.edges}e · ${v.stats.junctions}j`
                      : (v.note ?? `frozen ${selectedSnap?.manifest.date ?? ''}`)) + inventedNote(a.variants, vi)
                  }
                  aspect={a.width / a.height}
                  grid={{ w: a.width, h: a.height }}
                >
                  <RawArt html={v.svg} />
                </Panel>
              ))}
              {snapMode &&
                a.heats?.map((h) => (
                  <Panel
                    key={h.label}
                    label={<span className="text-warn">{h.label}</span>}
                    note={pairMode ? `hot = ${selectedSnap!.name} ≠ ${vsSnap!.name}` : 'hot = snapshot ≠ working tree'}
                    aspect={a.width / a.height}
                    pixelated
                    grid={{ w: a.width, h: a.height }}
                  >
                    <img src={h.url} alt="" style={{ background: HEAT_BG }} />
                  </Panel>
                ))}
            </CaseRow>
          )
        })}
        {run.pending && <PendingRow title={run.pending.name} />}
      </LabPage>
    </div>
  )
}

function AbAbout() {
  return (
    <>
      <p className="mb-2 max-w-[96ch]">
        Every case is traced by the planar engine once per <b>variant</b> — the same image, the same
        options, one <code>planarFit</code> flag apart. The boxes of a row share one camera (each row
        zooms independently), so you can zoom into a single junction and see what each variant did
        to it, side by side.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Input px</b> re-rasterizes the SVG cases at a different size: a tracer whose node and
        junction counts swing with input resolution is fragile, and only a resolution-independent
        source can reveal that. <b>Nodes/edges</b> reveals the wireframe already baked into every
        panel — square dots are corners, round are smooth, green rings are junction vertices — with
        no re-trace.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Baseline</b> (the dropdown) picks what to compare against: a snapshot frozen by{' '}
        <code>pnpm gen:absnapshot [name]</code> — each is its own subdir under test/ab-snapshots,
        so several coexist and you pick which to diff against (newest first; the manifest records
        the git rev + date). Both panels then trace the snapshot&apos;s own stored pixels, so what
        differs is the code, never the rasterizer; the raster switch is hidden because the input is
        pinned. Typical flow: BEFORE a change, freeze a baseline —{' '}
        <code>pnpm gen:absnapshot before-thing</code> — then this page shows exactly what the
        working tree changed against it. <b>Changed only</b> collapses the corpus to just the cases
        whose trace actually moved (an exact serialization diff — a snapshot IS{' '}
        <code>serializeDoc</code> at its rev), and each changed case gets a <b>diff heat</b> panel
        that rasterizes both traces and paints WHERE they disagree (the shared cold→hot ramp) — so
        a change is located, not just flagged. Re-run to re-bless a snapshot after a change is
        accepted. (Residual caveat: the browser&apos;s canvas PNG decode can differ from
        Node&apos;s by ±1 on a few partial-alpha pixels — the aurora story in docs/labs.md — which
        is far below anything judged visually here.)
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Compare with</b> is the second half of that question, and its default is the{' '}
        <b>working tree</b>. Point it at another <b>snapshot</b> instead and nothing is traced at
        all: both panels are frozen stamps, diffed against each other. That matters because the
        prescribed workflow produces two stamps per change — freeze <code>before-x</code>, change
        the tracer, freeze <code>after-x</code> — and those two are a <b>set</b>. A
        working-tree comparison decays the moment you keep editing; a frozen-vs-frozen one does
        not, and it is the only way to compare two revisions when neither is checked out. Such a
        set shows up in the Baseline dropdown under <b>⇄ Pairs</b> as a single entry that selects
        both sides at once — detected from the <code>before-</code>/<code>after-</code> naming, or
        recorded explicitly with <code>pnpm gen:absnapshot after-x --pair before-x</code> for names
        outside that convention. One guard is worth knowing: two stamps taken far apart may have
        traced <i>different pixels</i> for the same case (a fixture SVG was edited,{' '}
        <code>AB_SNAPSHOT_RES</code> changed), and a trace diff would then report an art change as
        a code change — so both stored input PNGs are compared byte-for-byte and a mismatched row
        is marked <b>input differs</b> and kept out of the counts rather than answered wrongly.
      </p>
      <p className="mb-2 max-w-[96ch]">
        A stamp freezes <b>two</b> traces per case — gradients off and on — so in Vs-snapshot mode
        the <b>Gradients</b> toggle only picks which frozen pair is on screen (both panels always
        use the same setting; the input is one stored PNG either way). The <b>changed</b> verdict
        is not a mode at all: a stamp freezes <b>both</b> traces per case (gradients off and on),
        both are compared, and <b>whichever moved is what you see</b> — its snapshot pair and its
        own diff heat, labelled with the setting, flat first. A case that moved in both shows two
        pairs and two heats; one that moved in neither shows the flat pair alone, because there
        is nothing to locate. The row badge always names the lane on screen (<i>changed ·
        gradients</i>, <i>unchanged · showing flat</i>) — worth reading, because two different
        baselines can put two different lanes in front of you and a lane switch looks exactly
        like a regression. (Real example: <code>checker</code>&apos;s gradient trace has been
        visibly warped since the oldest stamp on disk while its flat trace is pixel-perfect, so
        a baseline that moves it shows the warped lane and one that doesn&apos;t shows the clean
        one — same working tree, both times.) That is why there is no Gradients toggle here (nor an Input px one:
        the input is pinned to the stamp&apos;s stored pixels) — §14&apos;s fix moved four FLAT
        traces and no gradient one, and a page whose verdict follows a control is a page that can
        be read wrong.
      </p>
      <p className="mb-2 max-w-[96ch]">
        <b>Cases</b> picks the lane. The ⟐ <b>fixtures</b> are handcrafted to isolate one mechanism
        each, which makes them good gates and weak evidence — they are already &quot;good enough&quot;
        long before real art is. The ◆ <b>gallery</b> lane is a slice of the same brand marks{' '}
        <code>/labs/gallery</code> shows, rasterized on white exactly as that page does, so a change
        can be judged on a mark you recognize. The two controls are independent axes — this one
        picks the ART; what is traced is the variants (here) or whatever moved (Vs snapshot). One
        thing worth knowing about a ◆ row: <code>/labs/gallery</code> itself traces FLAT, so the{' '}
        <i>gradients off</i> panels are the gallery-parity view of that mark, and{' '}
        <i>gradients on</i> is what the studio would do to it (the product default, with the
        rampiness probe choosing per image). Both are stamped, so neither is lost. Those files are
        gitignored (trademarks); run{' '}
        <code>npm run fetch:logos</code> to fill the lane, edit <code>AB_LOGOS</code> in
        src/devtest/abCorpus.ts to change which marks it carries, or pass{' '}
        <code>--logos all</code> / <code>--logos a,b</code> to the snapshot writer for a one-off.
        Snapshots are <b>never committed</b> — they are local working artifacts, and this lane
        traces art that must not be redistributed.
      </p>
      <p className="max-w-[96ch]">
        Drop an image anywhere on the page (or use <b>Add image</b>) to run your own logo through
        every variant. Dropped images last for the session (and have no snapshot).
      </p>
    </>
  )
}

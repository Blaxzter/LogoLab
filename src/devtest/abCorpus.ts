// The Feature-A/B corpus + snapshot contract, in a form BOTH the Node snapshot
// writer and the browser view import — the same trick truthCorpus.ts plays, and
// for the same reason: a view that re-declares the case list can silently drift
// from what `pnpm gen:absnapshot` actually snapshots.
//
// ---------------------------------------------------------------------------
// What a snapshot is, and the rule that makes it comparable
//
// A snapshot freezes the tracer's OUTPUT at a chosen git revision so a later
// working tree can be judged against it visually (/labs/ab → "Vs snapshot").
// The confound to kill is the INPUT: the browser rasterizes SVG with canvas,
// the Node writer with resvg, and the two produce different pixels — a delta
// between the panels would then be "resvg vs canvas", not "old code vs new".
// So the writer stores THE EXACT PIXELS IT TRACED (a PNG per case) next to the
// traced SVGs, and the view traces the live code FROM THAT STORED PNG. One
// input file, two code revisions — the only remaining wobble is the browser's
// canvas PNG decode (±1 on a handful of partial-alpha pixels; the aurora
// caveat in docs/labs.md), which is orders of magnitude below re-rasterizing.
// ---------------------------------------------------------------------------

/** One A/B case. `path` is repo-relative — under public/ for the fixture lane, so the
 *  Node writer can read the file and the browser can fetch it (abUrl); the GALLERY lane
 *  points outside public/ and is resolved differently per consumer (see AB_LOGOS). */
export interface AbCorpusCase {
  /** Stable file-safe id — snapshot filenames derive from it. */
  id: string
  /** Display name (⟐ marks the handcrafted edge cases, ◆ the gallery marks). */
  name: string
  path: string
  kind: 'svg' | 'png'
  /** Composite the rasterized input on this colour instead of leaving it transparent.
   *  The gallery lane sets 'white' because /labs/gallery does — a brand mark on
   *  transparency is a different tracing problem from the one you looked at. */
  background?: string
}

export const AB_CORPUS: AbCorpusCase[] = [
  { id: 'orbit', name: 'orbit (ring)', kind: 'svg', path: 'public/examples/orbit.svg' },
  { id: 'bloom', name: 'bloom (crossings)', kind: 'svg', path: 'public/examples/bloom.svg' },
  { id: 'outline', name: 'outline', kind: 'svg', path: 'public/examples/outline.svg' },
  { id: 'summit', name: 'summit', kind: 'svg', path: 'public/examples/summit.svg' },
  { id: 'aurora', name: 'aurora', kind: 'svg', path: 'public/examples/aurora.svg' },
  { id: 'nebula', name: 'nebula', kind: 'png', path: 'public/examples/nebula.png' },
  { id: 'petals', name: 'petals', kind: 'png', path: 'public/examples/petals.png' },
  { id: 'bg-ramp', name: '⟐ bg-ramp — posterization bands', kind: 'svg', path: 'public/examples/edge-cases/bg-ramp.svg' },
  { id: 'bg-ramp-twin', name: '⟐ bg-ramp-twin — colour-class DELETE risk', kind: 'svg', path: 'public/examples/edge-cases/bg-ramp-twin.svg' },
  { id: 'cross-bars', name: '⟐ cross-bars — junction cluster (weld)', kind: 'svg', path: 'public/examples/edge-cases/cross-bars.svg' },
  { id: 'concentric', name: '⟐ concentric — circle/concentric snap', kind: 'svg', path: 'public/examples/edge-cases/concentric.svg' },
  { id: 'hairlines', name: '⟐ hairlines — sub-pixel strokes', kind: 'svg', path: 'public/examples/edge-cases/hairlines.svg' },
  { id: 'aa-seam', name: '⟐ aa-seam — nearest-colour crispness', kind: 'svg', path: 'public/examples/edge-cases/aa-seam.svg' },
  { id: 'checker', name: '⟐ checker — high-frequency aliasing', kind: 'svg', path: 'public/examples/edge-cases/checker.svg' },
  { id: 'scale-blind', name: '⟐ scale-blind — scale-relative snap ε (§10.1)', kind: 'svg', path: 'public/examples/edge-cases/scale-blind.svg' },
  { id: 'radial-glow', name: '⟐ radial-glow — 2-D gradient field', kind: 'svg', path: 'public/examples/edge-cases/radial-glow.svg' },
  { id: 'gradient-flat', name: '⟐ gradient-flat — render gate', kind: 'svg', path: 'public/examples/edge-cases/gradient-flat.svg' },
  { id: 'sharp-star', name: '⟐ sharp-star — corner detection', kind: 'svg', path: 'public/examples/edge-cases/sharp-star.svg' },
  { id: 'flute-flat', name: 'flute (flat twin) — near-colour pair ΔE 4.5', kind: 'svg', path: 'public/corpus/fluent/flat/flute.svg' },
  { id: 'wedge-counter', name: '⟐ wedge-counter — converging counter wedge (§15.8)', kind: 'svg', path: 'public/examples/edge-cases/wedge-counter.svg' },
  { id: 'seam-corner', name: '⟐ seam-corner — a seam ending ON a corner (§17)', kind: 'svg', path: 'public/examples/edge-cases/seam-corner.svg' },
  { id: 'acute-counter', name: '⟐ acute-counter — apex reconstructed past the ink (§18)', kind: 'svg', path: 'public/examples/edge-cases/acute-counter.svg' },
  { id: 'letter-joins', name: '⟐ letter-joins — curved-arm corner apex (§19)', kind: 'svg', path: 'public/examples/edge-cases/letter-joins.svg' },
  { id: 'peak-drop', name: '⟐ peak-drop — small isolated features under the despeckle floor (§20)', kind: 'svg', path: 'public/examples/edge-cases/peak-drop.svg' },
  { id: 'annulus', name: '⟐ annulus — hole winding + alpha', kind: 'svg', path: 'public/examples/edge-cases/annulus.svg' },
  { id: 'overlap', name: '⟐ overlap — layer decomposition', kind: 'svg', path: 'public/examples/edge-cases/overlap.svg' },
]

// ---------------------------------------------------------------------------
// The GALLERY lane — real brand marks, the art the defects are actually reported on
//
// The fixtures above are handcrafted to isolate one mechanism each, which is what makes
// them good gates and bad evidence: they are already "good enough" long before the real
// art is. /labs/gallery is where a change gets judged on marks a person recognizes, so
// the A/B stamp covers a slice of that corpus too.
//
// Those SVGs live in examples/logos/ and are GIT-IGNORED (trademarks — see
// examples/logos/README.md, `npm run fetch:logos` rehydrates them), so this file names
// them and each consumer resolves them its own way: the writer reads the filesystem and
// SKIPS what isn't there, the browser joins against devtest/logoCorpus's import.meta.glob
// bundle. Neither errors when the corpus was never fetched — the lane just goes empty.
// Nothing derived from them may be committed (see test/ab-snapshots/README.md).
//
// Twelve, not 152: every case is traced twice per stamp and once more per lab run, and a
// stamp that takes five minutes stops being run before a change. They are picked to span
// the tracer's failure families, one line each. Editing this list is the intended way to
// look at a different mark — `pnpm gen:absnapshot <name> --logos <a,b|all>` overrides it
// for one run without touching the file.
// ---------------------------------------------------------------------------

export interface AbLogoCase {
  /** Filename inside examples/logos/. */
  file: string
  /** What this mark is here to catch. */
  why: string
}

export const AB_LOGOS: AbLogoCase[] = [
  { file: 'affinity-designer.svg', why: 'ramp posterized into bands whose seams land on real edges (§14)' },
  { file: 'instagram.svg', why: 'a 2-D gradient field under a ring + dot — banding vs circle snap' },
  { file: 'firefox.svg', why: 'dense multi-stop gradients, soft flame edges — the ramp family at its worst' },
  { file: 'chrome.svg', why: 'three colour wedges meeting concentric discs — junction crossings' },
  { file: 'olympic-rings.svg', why: 'five overlapping thin rings — arc snap + crossing junctions' },
  { file: 'mastercard.svg', why: 'two overlapping discs with a blended intersection' },
  { file: 'ibm.svg', why: 'the 8-bar mark — sub-pixel horizontal hairlines' },
  { file: 'fedex.svg', why: 'letterform corners in a wordmark — corner recovery' },
  { file: 'coca-cola.svg', why: 'a long flowing script — node parsimony on smooth strokes' },
  { file: 'nike.svg', why: 'one big swoosh with a cusp at the tip' },
  { file: 'mercedes-benz.svg', why: 'a thin ring with three spokes into one centre junction' },
  { file: 'android.svg', why: 'flat art with rounded bar caps and small dots' },
]

/** `affinity-designer.svg` → `Affinity Designer`. */
const logoTitle = (file: string): string =>
  file
    .replace(/\.svg$/, '')
    .split('-')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ')

/** The gallery lane as corpus cases. `id` is prefixed so it can never collide with a
 *  fixture id, and the path is repo-relative but OUTSIDE public/ — `abUrl` does not
 *  apply to these; the browser feeds their markup in directly. */
export const AB_LOGO_CASES: AbCorpusCase[] = AB_LOGOS.map((l) => ({
  id: `logo-${l.file.replace(/\.svg$/, '')}`,
  name: `◆ ${logoTitle(l.file)} — ${l.why}`,
  kind: 'svg',
  path: `examples/logos/${l.file}`,
  background: 'white',
}))

/** SVG cases are rasterized at this width for the snapshot (the lab's default). */
export const AB_SNAPSHOT_RES = 512

/** ROOT of the snapshot store, repo-relative. Each snapshot is a NAMED SUBDIR beneath it —
 *  `test/ab-snapshots/<name>/` — holding that snapshot's manifest.json + per-case files, so
 *  several baselines can coexist and the A/B view offers them in a dropdown. `pnpm
 *  gen:absnapshot [name]` writes one (name defaults to the current git short rev). */
export const AB_SNAPSHOT_DIR = 'test/ab-snapshots'

/** Filesystem-safe snapshot folder name (also the dropdown key). Shared by the writer and any
 *  reader so a name round-trips identically. */
export const snapshotDirName = (name: string): string => name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-') || 'snapshot'

/**
 * The CONVENTIONAL counterpart of a snapshot name: `before-x` ↔ `after-x`, the naming
 * CLAUDE.md's workflow already prescribes. Returns null for a name outside the convention.
 *
 * This exists because the two stamps of a change are a SET, not two unrelated baselines:
 * freezing `before-x`, changing the tracer, then freezing `after-x` leaves a pair whose
 * whole point is to be diffed against each other — and before this the view could only
 * compare a stamp against the working tree, so the `after-` half was inert. `AbSnapshotManifest.pair`
 * records the same relationship EXPLICITLY for names that do not follow the convention;
 * the view accepts either.
 */
export function conventionalPartner(name: string): string | null {
  if (name.startsWith('before-')) return `after-${name.slice('before-'.length)}`
  if (name.startsWith('after-')) return `before-${name.slice('after-'.length)}`
  return null
}

/** The shared slug of a before-/after- pair (`before-checker` → `checker`), for labelling. */
export function pairSlug(name: string): string {
  return name.replace(/^(before|after)-/, '')
}

export interface AbSnapshotCase {
  id: string
  name: string
  /** Filenames inside AB_SNAPSHOT_DIR. `png` is THE input: the exact pixels the
   *  snapshot traced, which the view must trace too (see the header comment). */
  png: string
  /** Traced with gradients OFF (the product default for flat art). */
  flat: string
  /** Traced with gradients ON. */
  grad: string
  width: number
  height: number
}

export interface AbSnapshotManifest {
  /** Folder name under AB_SNAPSHOT_DIR (the dropdown key). Defaults to `rev`, or a label
   *  the author passed to `pnpm gen:absnapshot <name>` (e.g. "before-checker"). */
  name: string
  /** `git rev-parse --short HEAD` at generation, "+dirty" when the tracked tree
   *  had modifications — a snapshot of uncommitted code is honest but says so. */
  rev: string
  /** ISO date of generation (informational only — never used by the tracer). */
  date: string
  res: number
  /** The snapshot this one is the OTHER HALF of — set by `pnpm gen:absnapshot <name>
   *  --pair <base>`, i.e. "this stamp is the after of <base>". /labs/ab offers the two as
   *  one PAIR entry that selects both sides at once. Absent for a standalone baseline; the
   *  `before-x`/`after-x` naming convention (see `conventionalPartner`) is detected without
   *  it, so this field is only needed for names outside that convention. */
  pair?: string
  cases: AbSnapshotCase[]
}

/** Repo-relative public/ path → the URL the dev server AND a build serve. */
export const abUrl = (path: string): string => `/${path.replace(/^public\//, '')}`

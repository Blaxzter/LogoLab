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

/** One A/B case. `path` is repo-relative under public/ so the Node writer can
 *  read the file and the browser can fetch it (abUrl). */
export interface AbCorpusCase {
  /** Stable file-safe id — snapshot filenames derive from it. */
  id: string
  /** Display name (the ⟐ prefix marks the handcrafted edge cases). */
  name: string
  path: string
  kind: 'svg' | 'png'
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
  { id: 'radial-glow', name: '⟐ radial-glow — 2-D gradient field', kind: 'svg', path: 'public/examples/edge-cases/radial-glow.svg' },
  { id: 'gradient-flat', name: '⟐ gradient-flat — render gate', kind: 'svg', path: 'public/examples/edge-cases/gradient-flat.svg' },
  { id: 'sharp-star', name: '⟐ sharp-star — corner detection', kind: 'svg', path: 'public/examples/edge-cases/sharp-star.svg' },
  { id: 'flute-flat', name: 'flute (flat twin) — near-colour pair ΔE 4.5', kind: 'svg', path: 'public/corpus/fluent/flat/flute.svg' },
  { id: 'annulus', name: '⟐ annulus — hole winding + alpha', kind: 'svg', path: 'public/examples/edge-cases/annulus.svg' },
  { id: 'overlap', name: '⟐ overlap — layer decomposition', kind: 'svg', path: 'public/examples/edge-cases/overlap.svg' },
]

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
  cases: AbSnapshotCase[]
}

/** Repo-relative public/ path → the URL the dev server AND a build serve. */
export const abUrl = (path: string): string => `/${path.replace(/^public\//, '')}`

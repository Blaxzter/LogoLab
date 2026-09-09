// Freeze the tracer's current output for the /labs/ab "Vs snapshot" comparison.
//
//   pnpm gen:absnapshot [name] [--logos all|a,b,c|none] [--pair <base>]
//
// `name` is optional and defaults to the git short rev; pass one to keep a labelled
// baseline (e.g. `before-checker`). Each snapshot is its OWN subdir so several coexist
// and the A/B view lists them in a dropdown.
//
// TWO STAMPS OF ONE CHANGE ARE A PAIR. Freeze `before-x`, change the tracer, freeze
// `after-x`, and /labs/ab offers the two as a single PAIR entry that diffs them against
// each other — no working-tree trace involved, so the comparison stays valid however the
// tree moves on afterwards. The `before-`/`after-` prefix convention is detected on its
// own; `--pair <base>` records the same relationship explicitly for names that do not
// follow it ("this stamp is the after of <base>").
//
// THREE TRACE LANES per case (AB_LANES in abCorpus.ts), each at the resolution PRODUCTION
// uses for that kind of art rather than one convenient number: flat art at the flat cap,
// gradient/photo at the gradient cap, and MONO — which is not a subset of the colour path
// but the complement of it (see the AB_LANES comment). Their resolutions are recorded per
// case, so stamps frozen under the old single-resolution rule keep comparing correctly.
//
// TWO CASE LANES (both from abCorpus.ts): the handcrafted ⟐ fixtures, and a slice of the ◆
// GALLERY corpus — the real brand marks the defects get reported on. The gallery lane
// needs `npm run fetch:logos`; without it those files simply are not there and the lane
// is skipped with a note. `--logos` overrides the curated slice for one run: `all` takes
// every logo on disk (slow — 150+ marks, traced twice each), `none` skips the lane, and a
// comma list picks specific marks (`--logos instagram,stripe` — .svg optional).
//
// Writes, per case, into test/ab-snapshots/<name>/ (which is GIT-IGNORED — these are
// local working artifacts, and the gallery lane's inputs are trademarked art):
//   <id>.png        — THE INPUT for every lane tracing at AB_SNAPSHOT_RES: the exact
//                     pixels this snapshot traced (SVG cases rasterized by resvg at that
//                     width; PNG cases copied verbatim — production never upscales, so
//                     neither does a stamp). The lab traces the LIVE code from this same
//                     file, so the two panels differ only by code revision — never by
//                     rasterizer (see abCorpus.ts header).
//   <id>.r<res>.png — the same, for a lane production caps lower (the gradient lane).
//   <id>.flat.svg   — serialized trace, gradients OFF (the flat-art default).
//   <id>.grad.svg   — serialized trace, gradients ON.
//   <id>.mono.svg   — serialized trace, mono (threshold → mask → crisp → beautify).
//   manifest.json   — name, git rev (+dirty), date, resolution, case index.
//
// Intended workflow (also see CLAUDE.md): BEFORE a vectorizer change, freeze a baseline
// —  `pnpm gen:absnapshot before-<what>`  — then judge the working tree against it in
// /labs/ab (Changed only + Diff heat show exactly what moved, and where). Regenerate to
// re-bless after a change is accepted.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import {
  AB_CORPUS,
  AB_LANES,
  AB_LOGO_CASES,
  AB_SNAPSHOT_DIR,
  AB_SNAPSHOT_RES,
  conventionalPartner,
  lanePngName,
  snapshotDirName,
  type AbCorpusCase,
  type AbLaneKey,
  type AbSnapshotManifest,
} from './abCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const git = (cmd: string): string => execSync(cmd, { cwd: root }).toString().trim()
const rev = git('git rev-parse --short HEAD')
let dirty = false
try {
  execSync('git diff HEAD --quiet', { cwd: root })
} catch {
  dirty = true
}

const argv = process.argv.slice(2)
const flagAt = argv.findIndex((a) => a.startsWith('--'))
// Snapshot NAME: an optional CLI arg (`pnpm gen:absnapshot before-checker`), else the git rev.
// It is the subdir name AND the A/B dropdown label, so several baselines can coexist.
const name = snapshotDirName((flagAt === 0 ? undefined : argv[0]) ?? rev)
const logosArg = argv.includes('--logos') ? (argv[argv.indexOf('--logos') + 1] ?? '') : null
// `--pair <base>`: this stamp is the AFTER half of <base>. Recorded so /labs/ab can offer
// the two as one entry even when the names are outside the before-/after- convention.
const pairArg = argv.includes('--pair') ? snapshotDirName(argv[argv.indexOf('--pair') + 1] ?? '') : null
if (pairArg && !existsSync(join(root, AB_SNAPSHOT_DIR, pairArg))) {
  console.log(`  note: --pair ${pairArg} does not exist under ${AB_SNAPSHOT_DIR}/ — recording it anyway (stamp it and the pair appears)`)
}
const outDir = join(root, AB_SNAPSHOT_DIR, name)
mkdirSync(outDir, { recursive: true })

// The GALLERY lane, resolved against the filesystem: `--logos all` sweeps the fetched
// corpus, a comma list picks marks by name, and the default is abCorpus's curated slice.
// Anything missing is REPORTED, not fatal — a clean clone has no logos at all and must
// still be able to stamp the fixture lane.
function galleryCases(): AbCorpusCase[] {
  const dir = join(root, 'examples', 'logos')
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.svg')) : []
  const caseFor = (file: string): AbCorpusCase => ({
    id: `logo-${file.replace(/\.svg$/, '')}`,
    name: `◆ ${file.replace(/\.svg$/, '')}`,
    kind: 'svg',
    path: `examples/logos/${file}`,
    background: 'white',
  })
  if (logosArg === 'none') return []
  if (logosArg === 'all') return onDisk.map(caseFor)
  const wanted = logosArg
    ? logosArg
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => caseFor(f.endsWith('.svg') ? f : `${f}.svg`))
    : AB_LOGO_CASES
  const have = new Set(onDisk)
  const missing = wanted.filter((c) => !have.has(c.path.split('/').pop()!))
  if (missing.length) {
    console.log(
      `  skipping ${missing.length} gallery mark(s) not on disk (${missing
        .map((c) => c.path.split('/').pop())
        .join(', ')}) — \`npm run fetch:logos\` rehydrates them`,
    )
  }
  return wanted.filter((c) => have.has(c.path.split('/').pop()!))
}

const cases: AbCorpusCase[] = [...AB_CORPUS, ...galleryCases()]

const manifest: AbSnapshotManifest = {
  name,
  rev: dirty ? `${rev}+dirty` : rev,
  date: new Date().toISOString().slice(0, 10),
  createdAt: new Date().toISOString(),
  res: AB_SNAPSHOT_RES,
  ...(pairArg ? { pair: pairArg } : {}),
  cases: [],
}

/** One rasterization of a case, shared by every lane that traces at the same resolution
 *  (flat and mono both run at the flat cap, so the raster is decoded and stored once). */
interface Raster {
  bytes: Uint8Array
  img: ReturnType<typeof decodePng>
  file: string
}

const totalT0 = performance.now()
for (const c of cases) {
  const src = readFileSync(join(root, c.path))

  // The input pixels, ONE RASTER PER DISTINCT LANE RESOLUTION: rasterize SVG cases with
  // resvg (transparent background — the same policy the app's own canvas rasterization
  // uses); PNG cases pass through verbatim, because production never upscales a raster and
  // a stamp must not either.
  const rasters = new Map<number, Raster>()
  const rasterAt = (res: number): Raster => {
    const hit = rasters.get(res)
    if (hit) return hit
    const bytes: Uint8Array =
      c.kind === 'svg'
        ? new Resvg(src.toString('utf8'), {
            fitTo: { mode: 'width', value: res },
            // The gallery lane composites on white, exactly as /labs/gallery does; the
            // fixtures keep the transparent input the app's own rasterization produces.
            ...(c.background ? { background: c.background } : {}),
          })
            .render()
            .asPng()
        : src
    const img = decodePng(bytes)
    // A PNG fixture bigger than a lane's cap would be traced whole here while production
    // downscales it first — a silent input mismatch. Both PNG fixtures are 512², well
    // under every cap; say so rather than let a future one slip through.
    if (c.kind === 'png' && Math.max(img.width, img.height) > res) {
      console.log(
        `  note: ${c.id} is ${img.width}×${img.height}, above this lane's ${res}px cap — production would downscale it, this stamp traces it whole`,
      )
    }
    const raster = { bytes, img, file: lanePngName(c.id, res) }
    rasters.set(res, raster)
    return raster
  }

  const t0 = performance.now()
  const svgOf: Partial<Record<AbLaneKey, string>> = {}
  const timings: string[] = []
  for (const lane of AB_LANES) {
    const r = rasterAt(lane.res)
    const lt0 = performance.now()
    svgOf[lane.key] = serializeDoc(
      await traceImage(r.img as unknown as ImageData, {
        ...DEFAULT_VECTORIZE_OPTIONS,
        engine: 'planar',
        ...lane.opts,
        ...lane.resolve?.(r.img),
      }),
    )
    timings.push(`${lane.key} @${lane.res} ${((performance.now() - lt0) / 1000).toFixed(1)}s`)
  }

  for (const r of rasters.values()) writeFileSync(join(outDir, r.file), r.bytes)
  for (const lane of AB_LANES) writeFileSync(join(outDir, `${c.id}.${lane.key}.svg`), svgOf[lane.key]!)

  // `png`/`width`/`height` describe the PRIMARY raster; a lane that traced something else
  // records its own, and a reader resolves both through `laneFiles`.
  const primary = rasterAt(AB_SNAPSHOT_RES)
  const gradLane = AB_LANES.find((l) => l.key === 'grad')!
  const gradRaster = rasterAt(gradLane.res)
  manifest.cases.push({
    id: c.id,
    name: c.name,
    png: primary.file,
    flat: `${c.id}.flat.svg`,
    grad: `${c.id}.grad.svg`,
    mono: `${c.id}.mono.svg`,
    width: primary.img.width,
    height: primary.img.height,
    ...(gradRaster.file !== primary.file
      ? { gradPng: gradRaster.file, gradWidth: gradRaster.img.width, gradHeight: gradRaster.img.height }
      : {}),
  })
  console.log(
    `${c.id.padEnd(14)} ${primary.img.width}×${primary.img.height}  ${timings.join(' · ')}  = ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  )
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(
  `\n${manifest.cases.length} cases × ${AB_LANES.length} lanes (${AB_LANES.map((l) => `${l.key} @${l.res}`).join(', ')}) snapshotted at ${manifest.rev} in ${((performance.now() - totalT0) / 1000 / 60).toFixed(1)} min → ${AB_SNAPSHOT_DIR}/${name}/  (dropdown: "${name}")`,
)
const partner = pairArg ?? conventionalPartner(name)
if (partner) {
  const have = existsSync(join(root, AB_SNAPSHOT_DIR, partner))
  console.log(
    have
      ? `  paired with "${partner}" — /labs/ab lists them as one entry that diffs the two stamps directly`
      : `  pairs with "${partner}" once that stamp exists (pnpm gen:absnapshot ${partner})`,
  )
}

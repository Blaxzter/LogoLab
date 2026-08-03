// Freeze the tracer's current output for the /labs/ab "Vs snapshot" comparison.
//
//   pnpm gen:absnapshot [name] [--logos all|a,b,c|none]
//
// `name` is optional and defaults to the git short rev; pass one to keep a labelled
// baseline (e.g. `before-checker`). Each snapshot is its OWN subdir so several coexist
// and the A/B view lists them in a dropdown.
//
// TWO LANES (both from abCorpus.ts): the handcrafted ⟐ fixtures, and a slice of the ◆
// GALLERY corpus — the real brand marks the defects get reported on. The gallery lane
// needs `npm run fetch:logos`; without it those files simply are not there and the lane
// is skipped with a note. `--logos` overrides the curated slice for one run: `all` takes
// every logo on disk (slow — 150+ marks, traced twice each), `none` skips the lane, and a
// comma list picks specific marks (`--logos instagram,stripe` — .svg optional).
//
// Writes, per case, into test/ab-snapshots/<name>/ (which is GIT-IGNORED — these are
// local working artifacts, and the gallery lane's inputs are trademarked art):
//   <id>.png        — THE INPUT: the exact pixels this snapshot traced (SVG cases
//                     rasterized once by resvg at AB_SNAPSHOT_RES; PNG cases copied
//                     verbatim). The lab traces the LIVE code from this same file,
//                     so the two panels differ only by code revision — never by
//                     rasterizer (see abCorpus.ts header).
//   <id>.flat.svg   — serialized trace, gradients OFF (the flat-art default).
//   <id>.grad.svg   — serialized trace, gradients ON.
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
  AB_LOGO_CASES,
  AB_SNAPSHOT_DIR,
  AB_SNAPSHOT_RES,
  snapshotDirName,
  type AbCorpusCase,
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
  res: AB_SNAPSHOT_RES,
  cases: [],
}

for (const c of cases) {
  const src = readFileSync(join(root, c.path))
  // The input pixels: rasterize SVG cases ONCE (transparent background — the same
  // policy the app's own canvas rasterization uses); PNG cases pass through.
  const pngBytes =
    c.kind === 'svg'
      ? new Resvg(src.toString('utf8'), {
          fitTo: { mode: 'width', value: AB_SNAPSHOT_RES },
          // The gallery lane composites on white, exactly as /labs/gallery does; the
          // fixtures keep the transparent input the app's own rasterization produces.
          ...(c.background ? { background: c.background } : {}),
        })
          .render()
          .asPng()
      : src
  const img = decodePng(pngBytes)

  const trace = async (gradients: boolean): Promise<string> =>
    serializeDoc(
      await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients }),
    )

  const t0 = performance.now()
  const flat = await trace(false)
  const grad = await trace(true)
  writeFileSync(join(outDir, `${c.id}.png`), pngBytes)
  writeFileSync(join(outDir, `${c.id}.flat.svg`), flat)
  writeFileSync(join(outDir, `${c.id}.grad.svg`), grad)
  manifest.cases.push({
    id: c.id,
    name: c.name,
    png: `${c.id}.png`,
    flat: `${c.id}.flat.svg`,
    grad: `${c.id}.grad.svg`,
    width: img.width,
    height: img.height,
  })
  console.log(`${c.id.padEnd(14)} ${img.width}×${img.height}  flat+grad traced in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`\n${manifest.cases.length} cases snapshotted at ${manifest.rev} → ${AB_SNAPSHOT_DIR}/${name}/  (dropdown: "${name}")`)

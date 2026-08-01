// Freeze the tracer's current output for the /labs/ab "Vs snapshot" comparison.
//
//   pnpm gen:absnapshot [name]   (node src/devtest/writeAbSnapshots.ts [name])
//
// `name` is optional and defaults to the git short rev; pass one to keep a labelled
// baseline (e.g. `before-checker`). Each snapshot is its OWN subdir so several coexist
// and the A/B view lists them in a dropdown.
//
// Writes, per AB_CORPUS case, into test/ab-snapshots/<name>/:
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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import { AB_CORPUS, AB_SNAPSHOT_DIR, AB_SNAPSHOT_RES, snapshotDirName, type AbSnapshotManifest } from './abCorpus.ts'

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

// Snapshot NAME: an optional CLI arg (`pnpm gen:absnapshot before-checker`), else the git rev.
// It is the subdir name AND the A/B dropdown label, so several baselines can coexist.
const name = snapshotDirName(process.argv[2] ?? rev)
const outDir = join(root, AB_SNAPSHOT_DIR, name)
mkdirSync(outDir, { recursive: true })

const manifest: AbSnapshotManifest = {
  name,
  rev: dirty ? `${rev}+dirty` : rev,
  date: new Date().toISOString().slice(0, 10),
  res: AB_SNAPSHOT_RES,
  cases: [],
}

for (const c of AB_CORPUS) {
  const src = readFileSync(join(root, c.path))
  // The input pixels: rasterize SVG cases ONCE (transparent background — the same
  // policy the app's own canvas rasterization uses); PNG cases pass through.
  const pngBytes =
    c.kind === 'svg'
      ? new Resvg(src.toString('utf8'), { fitTo: { mode: 'width', value: AB_SNAPSHOT_RES } }).render().asPng()
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

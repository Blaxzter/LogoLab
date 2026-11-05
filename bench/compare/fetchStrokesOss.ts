// Fetch the strokes-oss icon sets at their pinned versions and freeze the sample.
//
//   node --experimental-strip-types bench/compare/fetchStrokesOss.ts
//
// For each set in strokesOss.ts STROKE_SETS: `npm pack <pkg>@<version>` into
// .bench-tools/datasets/strokes-oss/tarballs/ (npm checks the registry's integrity hash; the
// sha512 it reports is recorded), then the set's SVG directory and its LICENSE are unpacked
// into .bench-tools/datasets/strokes-oss/<set>@<version>/ by the small tar reader below — in
// process, so no shell `tar` (Git Bash's reads `E:` as a host) and no path from the archive
// reaches the file system unchecked: only `<dir>/<name>.svg` with a plain name, and the
// licence, are written.
//
// Then the sample (strokesOss.ts sampleStrokeIcons) is written to
// bench/compare/manifests/strokes-oss.json: every picked icon with set, version, file,
// sha256, licence and source; every icon passed over before the cut with its reason; the
// reasons counted over each whole set; and the dropped set(s) with the measurement that
// dropped them. corpus.ts verifies every sha256 before a run, as it does for svg-emoji.
//
// Re-running it with the same pins reproduces the manifest byte for byte (apart from
// `created`); changing a pin is a new corpus and should be a new manifest revision.

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { DATASETS, REPO } from './paths.ts'
import {
  classifyStrokeIcon,
  drawingBody,
  PHOSPHOR_DROP_FLOOR,
  SAMPLE_PER_SET,
  sampleStrokeIcons,
  STROKE_SETS,
  type StrokeCandidate,
  type StrokeSetId,
} from './strokesOss.ts'

const ROOT = join(DATASETS, 'strokes-oss')
const TARBALLS = join(ROOT, 'tarballs')
const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** Entries of a .tgz: ustar names (prefix + name), GNU `L` long names and pax `path=`. */
function* tarEntries(tgz: Uint8Array): Generator<{ name: string; data: Buffer }> {
  const buf = gunzipSync(tgz)
  let off = 0
  let longName: string | null = null
  const str = (o: number, n: number): string => {
    const s = buf.subarray(o, o + n)
    const z = s.indexOf(0)
    return (z >= 0 ? s.subarray(0, z) : s).toString('utf8')
  }
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break
    const size = Number.parseInt(str(off + 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(buf[off + 156] || 48)
    const prefix = str(off + 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${str(off, 100)}` : str(off, 100))
    longName = null
    const data = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') longName = data.toString('utf8').replace(/\0+$/, '')
    else if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (m) longName = m[1]
    } else if (type === '0' || type === '\0') yield { name, data: Buffer.from(data) }
  }
}

function pack(pkg: string, version: string): { file: string; integrity: string } {
  mkdirSync(TARBALLS, { recursive: true })
  // One command string: npm is a .cmd shim on Windows and needs a shell; every part of it
  // is a constant from STROKE_SETS or our own path.
  const out = execSync(`npm pack ${pkg}@${version} --json --pack-destination "${TARBALLS}"`, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const info = JSON.parse(out.slice(out.indexOf('[')))[0]
  return { file: join(TARBALLS, basename(info.filename)), integrity: info.integrity }
}

const linesOf = (s: string) => s.split('\n')

function main(): void {
  const candidates: StrokeCandidate[] = []
  const setsMeta: Record<string, unknown>[] = []
  const dropped: Record<string, unknown>[] = []
  const files = new Map<string, { file: string; sha256: string }>() // `${set}/${name}`
  for (const s of STROKE_SETS) {
    const { file, integrity } = pack(s.pkg, s.version)
    const tgz = readFileSync(file)
    const dir = join(ROOT, `${s.id}@${s.version}`)
    mkdirSync(dir, { recursive: true })
    let licence = ''
    const mine: StrokeCandidate[] = []
    for (const e of tarEntries(tgz)) {
      if (e.name === s.licenseFile) {
        licence = e.data.toString('utf8')
        writeFileSync(join(dir, 'LICENSE'), e.data)
        continue
      }
      if (!e.name.startsWith(s.dir)) continue
      const name = e.name.slice(s.dir.length)
      // Plain file names only: nothing in an archive picks a path outside the set's dir.
      if (!/^[\w.-]+\.svg$/.test(name)) continue
      writeFileSync(join(dir, name), e.data)
      const icon = name.replace(/\.svg$/, '')
      mine.push({ set: s.id, name: icon, svg: e.data.toString('utf8') })
      files.set(`${s.id}/${icon}`, { file: `${s.id}@${s.version}/${name}`, sha256: sha256(e.data) })
    }
    if (!licence) throw new Error(`${s.pkg}@${s.version}: no ${s.licenseFile} in the tarball`)
    const noStroke = mine.filter((c) => (classifyStrokeIcon(c.svg) ?? '').startsWith('no strokes')).length
    const meta = {
      set: s.id,
      package: s.pkg,
      version: s.version,
      tarball: basename(file),
      tarballSha256: sha256(tgz),
      integrity,
      license: s.license,
      licenseSha256: sha256(licence),
      copyright:
        linesOf(licence)
          .find((l) => /copyright/i.test(l))
          ?.trim() ?? null,
      source: s.url,
      icons: mine.length,
      noStrokes: noStroke,
    }
    if (mine.length && noStroke / mine.length >= PHOSPHOR_DROP_FLOOR) {
      dropped.push({
        ...meta,
        reason:
          `${noStroke}/${mine.length} icons have no stroke: the published weight is filled outlines ` +
          '(fill="currentColor" paths), so it has no stroke ground truth and was dropped',
      })
      console.log(`  ${s.id}: DROPPED — ${noStroke}/${mine.length} icons have no stroke`)
      continue
    }
    setsMeta.push(meta)
    candidates.push(...mine)
    console.log(`  ${s.id}: ${mine.length} icons (${s.pkg}@${s.version})`)
  }

  // In-sample: the Lucide icons the centreline engine was developed on, by fixture name.
  const inSample = new Set<string>()
  for (const d of ['line-art', 'colour-line-art']) {
    const p = join(REPO, 'public', 'examples', d)
    if (!existsSync(p)) continue
    for (const f of readdirSync(p)) {
      const m = /^(?:cl-)?lucide-(.+)\.svg$/.exec(f)
      if (m) inSample.add(m[1])
    }
  }
  const lucideBodies = new Set(
    candidates.filter((c) => c.set === 'lucide' && inSample.has(c.name)).map((c) => drawingBody(c.svg)),
  )
  const sample = sampleStrokeIcons(candidates, SAMPLE_PER_SET, inSample, lucideBodies)
  const setOf = new Map(STROKE_SETS.map((s) => [s.id, s]))
  const rows = sample.picked.map((c) => {
    const s = setOf.get(c.set as StrokeSetId)
    const f = files.get(`${c.set}/${c.name}`)
    if (!s || !f) throw new Error(`no file for ${c.set}/${c.name}`)
    return {
      set: c.set,
      name: c.name,
      version: s.version,
      file: f.file,
      sha256: f.sha256,
      license: s.license,
      source: `${s.pkg}@${s.version} ${s.dir.replace(/^package\//, '')}${c.name}.svg (${s.url})`,
    }
  })
  const manifest = {
    created: new Date().toISOString(),
    sampler: `per set: rank by sha1("<set>/<name>") ascending, take the first ${SAMPLE_PER_SET} eligible (strokesOss.ts)`,
    inSample: [...inSample].sort(),
    sets: setsMeta,
    dropped,
    counts: sample.counts,
    skipped: sample.skipped,
    rows,
  }
  const out = join(REPO, 'bench', 'compare', 'manifests', 'strokes-oss.json')
  writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`)
  console.log(`  ${rows.length} icons, ${sample.skipped.length} passed over → ${out}`)
  for (const [set, c] of Object.entries(sample.counts)) console.log(`    ${set}: ${JSON.stringify(c)}`)
}

main()

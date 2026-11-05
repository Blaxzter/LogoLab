// Publish one comparison run to the Hugging Face dataset Blaxzter/logolab-bench — the
// benchmark's public page, and what the hosted /labs/bench reads.
//
//   BENCH_TOOLS=… node --experimental-strip-types bench/compare/publishHf.ts --run v7
//        [--list] [--index runs.json] [--out dir] [--upload]
//
// DRY RUN by default: it builds the staging directory and prints what it holds (file count,
// size, per-corpus counts); `--list` prints every file. Nothing leaves the machine until
// `--upload`, which hands the staging directory to `hf upload` (the hf CLI, logged in). hf splits
// a folder this size into several commits and resumes if re-run. It refuses if the dataset repo
// does not exist yet: creating the public repo is a
// decision, not a side effect of a script.
//
// Staging, .bench-tools/hf-staging/<run>/, mirrors the repo root:
//
//   README.md  LICENSES.md  runs.json        (the card and licences only for the NEWEST run)
//   <run>/results.jsonl  results.json  summary.md  ATTRIBUTION.md
//   <run>/manifests/<corpus manifest>.json  cases.json
//   <run>/cases/<corpus>/<case>/truth.svg  <tool>.svg  overlay.json
//
// summary.md and ATTRIBUTION.md are written here, from the run's rows and this checkout's report
// code, so the published prose follows the publishing commit while every number stays the run's.
// LICENSES.md carries the MIT and ISC texts those licences require to travel with the copies.
//
// SVGs only. The PNG renders stay home: they are reproducible from the SVGs, they are most
// of the run's size, and the page draws the SVG (benchSource.ts maps a PNG request to it).
//
// What makes it refuse, loudly, with exit code 1 and nothing uploaded:
//   • a corpus not on hfCard.ts's PUBLISHABLE allowlist — the private examples/logos/ corpus
//     in particular, and any corpus nobody has checked the licence of;
//   • a case whose licence is not one its corpus may carry, or that has no licence on record;
//   • an answer sheet that resolves into examples/logos/.
//   • a case under MIT or ISC whose licence text is not on hand, or does not match its manifest;
//   • a markdown table whose rows disagree with its header: it renders as a paragraph of pipes.
// A case whose authored SVG cannot be found is still published (its outputs and rows are
// data) and says so in manifests/cases.json, the way a refused ground truth keeps its row.
//
// Answer sheets: the path the run itself read (its pairs.jsonl), else the corpus loader.
// A file that lives in this repo is taken from the run's LogoLab commit (`git show`), so a
// fixture edited after the run is staged as it was scored, not as it is today.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { HUB_BASE, parseRunIndex, type RunIndexEntry } from '../../src/components/labs/bench/benchSource.ts'
import type { BenchResults } from '../../src/components/labs/bench/benchData.ts'
import { loadCorpus } from './corpus.ts'
import {
  HF_REPO,
  type LicenceText,
  attributionMarkdown,
  brokenTables,
  publishable,
  cardMarkdown,
  corpusOf,
  flattenRows,
  isPrivatePath,
  licensesMarkdown,
  mergeRunIndex,
  missingLicenceTexts,
  publicResults,
  publishProblems,
  runEntry,
  toJsonl,
} from './hfCard.ts'
import { LOGOS_COMMIT } from './logosCc0.ts'
import { DATASETS, REPO, RESULTS, TOOLS } from './paths.ts'
import { summaryMarkdown } from './report.ts'
import type { CorpusId, ScoreRow } from './types.ts'

const argv = process.argv.slice(2)
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (k: string): boolean => argv.includes(k)

const RUN = arg('--run')
if (!RUN || !/^[\w.-]+$/.test(RUN)) {
  console.error('usage: publishHf.ts --run <name> [--list] [--index runs.json] [--out dir] [--upload]')
  process.exit(2)
}
const UPLOAD = has('--upload')
const RUN_DIR = join(RESULTS, RUN)
const STAGING_ROOT = resolve(TOOLS, 'hf-staging')
const OUT = resolve(arg('--out') ?? join(STAGING_ROOT, RUN))

const ALLOWLIST_NOTE =
  'A corpus is published only once it is on the allowlist in bench/compare/hfCard.ts (PUBLISHABLE) with the licences it may carry.'

function refuse(lines: string[], note?: string): never {
  console.error('')
  console.error('================================================================')
  console.error(`  REFUSING TO PUBLISH run ${RUN}`)
  console.error('================================================================')
  for (const l of lines) console.error(`  ✗ ${l}`)
  console.error('')
  console.error('  Nothing was uploaded.')
  if (note) console.error(`  ${note}`)
  console.error('')
  process.exit(1)
}

if (!existsSync(join(RUN_DIR, 'results.json'))) refuse([`no results.json in ${RUN_DIR}`])
const data = publicResults(JSON.parse(readFileSync(join(RUN_DIR, 'results.json'), 'utf8')) as BenchResults)
const problems = publishProblems(data)
if (problems.length)
  refuse(
    problems.length > 40 ? [...problems.slice(0, 40), `… and ${problems.length - 40} more`] : problems,
    ALLOWLIST_NOTE,
  )

// ── licence texts ──────────────────────────────────────────────────────────────────────────
function licenceTexts(): LicenceText[] {
  const carried = new Set((data.meta.cases ?? []).map((c) => c.license))
  const out: LicenceText[] = []
  const manifest = JSON.parse(
    readFileSync(join(REPO, 'bench', 'compare', 'manifests', 'strokes-oss.json'), 'utf8'),
  ) as {
    sets: { set: string; package: string; version: string; license: string; licenseSha256: string }[]
  }
  for (const s of manifest.sets) {
    const file = join(DATASETS, 'strokes-oss', `${s.set}@${s.version}`, 'LICENSE')
    if (!carried.has(s.license) || !existsSync(file)) continue
    const bytes = readFileSync(file)
    if (createHash('sha256').update(bytes).digest('hex') !== s.licenseSha256)
      refuse([`${file} does not match the sha256 in manifests/strokes-oss.json`])
    out.push({ licence: s.license, title: `${s.package} ${s.version}`, text: bytes.toString('utf8') })
  }
  // The vendored NOTICE holds the licence, then a note about this repository's sample: only the first half ships.
  const fluent = join(REPO, 'public', 'corpus', 'fluent', 'NOTICE')
  for (const licence of carried)
    if (/^MIT \(microsoft/.test(licence) && existsSync(fluent))
      out.push({
        licence,
        title: 'Microsoft Fluent UI Emoji',
        text: readFileSync(fluent, 'utf8').split('\nThe SVGs under')[0],
      })
  return out
}
const texts = licenceTexts()
const noText = missingLicenceTexts(data, texts)
if (noText.length) refuse(noText.map((l) => `no licence text on hand for "${l}"; it has to ship with the copies`))

// The staging directory is rebuilt from scratch, so it must be one that is ours to delete:
// under .bench-tools/hf-staging/, or a new or empty directory named with --out.
const ours = OUT.startsWith(STAGING_ROOT + sep)
if (!ours && existsSync(OUT) && readdirSync(OUT).length > 0)
  refuse([`--out ${OUT} is not empty and not under ${STAGING_ROOT}; it will not be cleared`])
if (OUT === RESULTS || OUT.startsWith(RESULTS + sep) || RESULTS.startsWith(OUT + sep) || OUT === resolve(TOOLS))
  refuse([`staging ${OUT} would overlap the results directory`])

// ── answer sheets ──────────────────────────────────────────────────────────────────────────
const caseIds = [...new Set(data.rows.map((r) => r.caseId))]
const byCase = new Map<string, string>()
const pairsFile = join(RUN_DIR, 'pairs.jsonl')
if (existsSync(pairsFile))
  for (const line of readFileSync(pairsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const p = JSON.parse(line) as { key: string; gt_svg?: string }
    const id = p.key.slice(p.key.indexOf('|') + 1)
    if (p.gt_svg && !byCase.has(id)) byCase.set(id, p.gt_svg)
  }
for (const corpus of new Set(caseIds.map((id) => corpusOf(id)))) {
  if (caseIds.every((id) => !id.startsWith(`${corpus}/`) || byCase.has(id))) continue
  try {
    for (const c of loadCorpus(corpus as CorpusId) ?? []) if (!byCase.has(c.id)) byCase.set(c.id, c.svgPath)
  } catch (e) {
    console.warn(
      `  ${corpus}: the corpus loader failed (${(e as Error).message}); its answer sheets come from pairs.jsonl only`,
    )
  }
}
const privateGt = [...byCase.entries()].filter(([id, p]) => caseIds.includes(id) && isPrivatePath(p))
if (privateGt.length)
  refuse(
    privateGt.map(([id, p]) => `${id}: answer sheet ${p} is in the private logo corpus`),
    ALLOWLIST_NOTE,
  )

// The LogoLab checkouts a tracked answer sheet can live in: this one, and the main checkout
// a worktree hangs off (where the run was most likely made).
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO })
const CHECKOUTS = [REPO, ...(common.status === 0 ? [dirname(resolve(common.stdout.toString().trim()))] : [])]

/** The answer sheet's bytes as the run scored them. */
function authoredBytes(path: string): { bytes: Buffer; from: string } | null {
  // A path in a LogoLab checkout, outside the gitignored .bench-tools/: read it at the run's
  // commit, so a later edit to a fixture does not change what is published.
  const abs = resolve(path)
  const root = CHECKOUTS.find((r) => abs.startsWith(r + sep) && !abs.startsWith(join(r, '.bench-tools') + sep))
  const rel = root ? relative(root, abs).split(sep).join('/') : null
  if (rel && data.meta.logolab) {
    const r = spawnSync('git', ['show', `${data.meta.logolab}:${rel}`], { cwd: REPO, maxBuffer: 64 << 20 })
    if (r.status === 0) return { bytes: r.stdout, from: `git ${data.meta.logolab}:${rel}` }
  }
  return existsSync(path) ? { bytes: readFileSync(path), from: path } : null
}

// ── stage ──────────────────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true })
const runOut = join(OUT, RUN)
mkdirSync(join(runOut, 'manifests'), { recursive: true })
const staged: string[] = []
const put = (rel: string, content: string | Buffer) => {
  const file = join(OUT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  staged.push(rel)
}
const copy = (from: string, rel: string) => {
  const file = join(OUT, rel)
  mkdirSync(dirname(file), { recursive: true })
  copyFileSync(from, file)
  staged.push(rel)
}

put(`${RUN}/results.json`, JSON.stringify(data, null, 1))
put(
  `${RUN}/summary.md`,
  summaryMarkdown(data.rows as unknown as ScoreRow[], data.meta as unknown as Record<string, unknown>),
)
put(`${RUN}/ATTRIBUTION.md`, attributionMarkdown(LOGOS_COMMIT))
put(`${RUN}/results.jsonl`, toJsonl(flattenRows(data, RUN)))

const manifests = new Set(
  (data.meta.corpora ?? []).map((c) => publishable(c)?.manifest).filter((m): m is string => !!m),
)
for (const name of manifests) {
  const file = join(REPO, 'bench', 'compare', 'manifests', name)
  if (existsSync(file)) copy(file, `${RUN}/manifests/${name}`)
  else console.warn(`  manifest ${name} not in this checkout; not staged`)
}

const tools = new Map<string, Set<string>>()
for (const r of data.rows) {
  let s = tools.get(r.caseId)
  if (!s) tools.set(r.caseId, (s = new Set()))
  s.add(r.tool)
}
const meta = new Map((data.meta.cases ?? []).map((c) => [c.id, c]))
const counts = { svgs: 0, truths: 0, overlays: 0, bytes: 0 }
const caseRecords: Record<string, unknown>[] = []
const missingGt: string[] = []
for (const id of caseIds) {
  const corpus = corpusOf(id)
  const name = id.slice(corpus.length + 1)
  const dir = join(RUN_DIR, 'cases', corpus, name)
  const rel = `${RUN}/cases/${corpus}/${name}`
  // Only files named after a tool that has a row for this case: no strays, no renders.
  // A tool with a row but no SVG (it failed: no output) is named, so the file list and the
  // rows agree on what is missing; its row, scored as a blank white image, is in results.*.
  const noSvg: string[] = []
  for (const tool of tools.get(id) ?? []) {
    const svg = join(dir, `${tool}.svg`)
    if (existsSync(svg)) {
      copy(svg, `${rel}/${tool}.svg`)
      counts.svgs++
    } else noSvg.push(tool)
  }
  if (existsSync(join(dir, 'overlay.json'))) {
    copy(join(dir, 'overlay.json'), `${rel}/overlay.json`)
    counts.overlays++
  }
  const gtPath = byCase.get(id)
  const gt = gtPath ? authoredBytes(gtPath) : null
  if (gt) {
    put(`${rel}/truth.svg`, gt.bytes)
    counts.truths++
  } else missingGt.push(id)
  const c = meta.get(id)
  caseRecords.push({
    id,
    corpus,
    license: c?.license ?? null,
    source: c?.source ?? null,
    lane: c?.lane ?? null,
    gtRefusal: c?.gtRefusal ?? null,
    truth: gt ? `cases/${corpus}/${name}/truth.svg` : null,
    truthSha256: gt ? createHash('sha256').update(gt.bytes).digest('hex') : null,
    truthMissing: gt ? null : gtPath ? `not found: ${gtPath}` : 'no answer sheet on record',
    noSvg,
  })
}
put(
  `${RUN}/manifests/cases.json`,
  `${JSON.stringify({ run: RUN, logolab: data.meta.logolab, cases: caseRecords }, null, 1)}\n`,
)

// ── index, card ────────────────────────────────────────────────────────────────────────────
async function publishedIndex(): Promise<RunIndexEntry[]> {
  const local = arg('--index')
  if (local) return parseRunIndex(JSON.parse(readFileSync(local, 'utf8')))
  try {
    const r = await fetch(`${HUB_BASE}runs.json`, { signal: AbortSignal.timeout(15000) })
    if (r.status === 404 || r.status === 401) return [] // not published yet (a missing repo answers 401)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return parseRunIndex(await r.json())
  } catch (e) {
    // Uploading an index built without the published one would drop every other run from it.
    if (UPLOAD) refuse([`could not read the published runs.json (${(e as Error).message}); pass --index <file>`])
    console.warn(`  could not read the published runs.json (${(e as Error).message}): indexing this run alone`)
    return []
  }
}

const resultsBytes = statSync(join(runOut, 'results.json')).size
const index = mergeRunIndex(await publishedIndex(), runEntry(data, RUN, resultsBytes))
put('runs.json', `${JSON.stringify({ repo: HF_REPO, runs: index }, null, 1)}\n`)
// The card and its licence table describe the NEWEST run (its leaderboard is the dataset's
// headline). Publishing an older run must not replace them with that run's: both are left
// out of the staging, so the upload keeps the published ones. The card's `configs` list then
// lacks this run until the newest run is published again (which re-writes it from the index).
const newest = index[0]?.name === RUN
if (newest) put('LICENSES.md', licensesMarkdown(data, texts))
for (const rel of staged) counts.bytes += statSync(join(OUT, rel)).size
if (newest) put('README.md', cardMarkdown({ data, run: RUN, index, counts }))
else
  console.warn(
    `  ${RUN} is not the newest run (${index[0]?.name}): README.md and LICENSES.md not staged, the published ones stay.\n` +
      `  Re-publish ${index[0]?.name} afterwards to give ${RUN} a dataset-viewer config.`,
  )

const broken = staged
  .filter((rel) => rel.endsWith('.md'))
  .flatMap((rel) => brokenTables(readFileSync(join(OUT, rel), 'utf8')).map((p) => `${rel}: ${p}`))
if (broken.length) refuse(broken)

// ── report ─────────────────────────────────────────────────────────────────────────────────
let total = 0
for (const rel of staged) total += statSync(join(OUT, rel)).size
const listFile = `${OUT}.files.txt`
writeFileSync(listFile, `${staged.sort().join('\n')}\n`)

console.log(`\nStaged run ${RUN} for ${HF_REPO} in ${OUT}`)
console.log(`  ${staged.length} files, ${(total / 1e6).toFixed(1)} MB`)
console.log(
  `  ${data.rows.length} rows · ${caseIds.length} cases · ${counts.svgs} tool SVGs · ${counts.truths} answer sheets · ${counts.overlays} overlays`,
)
const perCorpus = new Map<string, number>()
for (const id of caseIds) perCorpus.set(corpusOf(id), (perCorpus.get(corpusOf(id)) ?? 0) + 1)
for (const [c, n] of perCorpus) console.log(`    ${c.padEnd(14)} ${n} cases`)
console.log(`  runs.json: ${index.map((r) => r.name).join(', ')}`)
const noSvgRows = caseRecords.reduce((s, c) => s + (c.noSvg as string[]).length, 0)
if (noSvgRows) console.log(`  ${noSvgRows} row(s) with no SVG (failed runs; named in manifests/cases.json noSvg)`)
if (missingGt.length)
  console.warn(`  ${missingGt.length} case(s) without an answer sheet: ${missingGt.slice(0, 8).join(', ')}`)
console.log('  top level:')
for (const rel of staged.filter((r) => !r.includes('/cases/')).sort()) {
  console.log(`    ${rel.padEnd(36)} ${(statSync(join(OUT, rel)).size / 1e3).toFixed(1)} kB`)
}
console.log(`  every file: ${listFile}${has('--list') ? '' : ' (or pass --list)'}`)
if (has('--list')) for (const rel of staged.sort()) console.log(`    ${rel}`)

if (!UPLOAD) {
  console.log('\nDry run: nothing uploaded. Re-run with --upload to publish this directory.')
  process.exit(0)
}

// ── upload ─────────────────────────────────────────────────────────────────────────────────
const info = await fetch(`https://huggingface.co/api/datasets/${HF_REPO}`, {
  signal: AbortSignal.timeout(15000),
}).catch(() => null)
if (!info || info.status === 404 || info.status === 401)
  refuse([
    `the dataset ${HF_REPO} does not exist (or is not visible). Create it on purpose first:`,
    `hf repos create ${HF_REPO} --repo-type dataset`,
  ])
console.log(`\nUploading ${relative(process.cwd(), OUT) || OUT} → datasets/${HF_REPO} …`)
const up = spawnSync(
  'hf',
  [
    'upload',
    HF_REPO,
    OUT,
    '.',
    '--repo-type',
    'dataset',
    // A republished run replaces the old one: its files not in this staging go.
    '--delete',
    `${RUN}/**`,
    '--commit-message',
    `Publish run ${RUN} (LogoLab ${data.meta.logolab})`,
  ],
  { stdio: 'inherit' },
)
if (up.status !== 0) {
  console.error(`hf upload failed (exit ${up.status ?? up.error?.message})`)
  process.exit(1)
}
console.log(`Published: https://huggingface.co/datasets/${HF_REPO}/tree/main/${RUN}`)

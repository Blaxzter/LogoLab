// Publishing the benchmark to Hugging Face (bench/compare/hfCard.ts) and reading it back
// (src/components/labs/bench/benchSource.ts). The two halves that must not regress quietly:
// the publish REFUSES anything not on the allowlist (the private logo corpus first), and the
// hosted page asks for files at the paths the publish puts them.

import test from 'node:test'
import assert from 'node:assert/strict'
import type { BenchResults, BenchRow } from '../src/components/labs/bench/benchData.ts'
import {
  HUB_BASE,
  LOCAL_SOURCE,
  hubSource,
  parseRunIndex,
  renderBox,
  sourceUrl,
} from '../src/components/labs/bench/benchSource.ts'
import {
  PUBLISHABLE,
  cardMarkdown,
  flattenRows,
  isPrivatePath,
  mergeRunIndex,
  publishProblems,
  runEntry,
  sizeCategory,
  toJsonl,
} from '../bench/compare/hfCard.ts'

const row = (tool: string, caseId: string, extra: Record<string, unknown> = {}): BenchRow => ({
  tool,
  caseId,
  corpus: caseId.slice(0, caseId.indexOf('/')),
  heldOut: caseId.startsWith('svgemoji'),
  status: 'ok',
  lane: 'colour',
  ...extra,
})

function run(cases: { id: string; license: string; source?: string }[], rows?: BenchRow[]): BenchResults {
  const tools = ['logolab-auto', 'vtracer-default', 'potrace-bin']
  const corpora = [...new Set(cases.map((c) => c.id.slice(0, c.id.indexOf('/'))))]
  return {
    meta: {
      run: 't',
      date: '2026-10-26T09:00:00.000Z',
      res: 512,
      logolab: 'abc1234',
      corpora,
      tools,
      versions: Object.fromEntries(tools.map((t) => [t, `${t} 1.0`])),
      cases: cases.map((c) => ({
        id: c.id,
        lane: 'colour',
        license: c.license,
        source: c.source ?? 'x',
        gtRefusal: null,
      })),
    },
    rows:
      rows ??
      cases.flatMap((c, i) =>
        tools.map((t, k) =>
          row(t, c.id, {
            meanDeltaE: (k + 1) * (i + 1),
            chamfer: k + 0.5,
            docNodes: 10 * (k + 1),
            tangentBreaks: k,
            sbDino: 1 - k / 10,
          }),
        ),
      ),
  }
}

const emoji = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `svgemoji-v0/e${i}-twemoji`, license: 'CC-BY-4.0' }))

test('a run of allowlisted corpora with their licences may be published', () => {
  const d = run([...emoji(3), { id: 'truth0/aa-seam', license: 'LogoLab fixture' }])
  assert.deepEqual(publishProblems(d), [])
})

test('the private logo corpus, or any corpus not on the allowlist, refuses the publish', () => {
  const d = run([...emoji(2), { id: 'logos/apple', license: 'trademark', source: 'examples/logos/apple.svg' }])
  const p = publishProblems(d)
  assert.ok(p.some((x) => /corpus "logos" is not on the publish allowlist/.test(x)))
  assert.ok(p.some((x) => /private examples\/logos/.test(x)))
  assert.equal(PUBLISHABLE.logos, undefined)
  // A row naming a corpus the meta does not list still counts.
  const rows = [...run(emoji(1)).rows, row('logolab-auto', 'gallery/x')]
  assert.ok(publishProblems(run(emoji(1), rows)).some((x) => /"gallery"/.test(x)))
})

test('a licence its corpus may not carry, or none on record, refuses the publish', () => {
  // OpenMoji is CC-BY-SA: allowed in the full split, not in the Twemoji-only v0.
  const sa = run([{ id: 'svgemoji-v0/00A9-openmoji', license: 'CC-BY-SA-4.0' }])
  assert.ok(publishProblems(sa).some((x) => /licence "CC-BY-SA-4.0" is not one svgemoji-v0/.test(x)))
  assert.deepEqual(publishProblems(run([{ id: 'svgemoji/00A9-openmoji', license: 'CC-BY-SA-4.0' }])), [])
  const orphan = run(emoji(1), [...run(emoji(1)).rows, row('logolab-auto', 'svgemoji-v0/nope')])
  assert.ok(publishProblems(orphan).some((x) => /svgemoji-v0\/nope: no meta.cases entry/.test(x)))
  assert.ok(PUBLISHABLE['strokes-oss'].licences.test('ISC (Lucide; portions MIT, Feather)'))
  assert.ok(PUBLISHABLE['strokes-oss'].licences.test('MIT (Tabler Icons)'))
  assert.ok(PUBLISHABLE['logos-cc0'].licences.test('CC0-1.0'))
})

test('isPrivatePath catches the logo corpus on either separator, and nothing else', () => {
  assert.ok(isPrivatePath('E:\\repo\\examples\\logos\\apple.svg'))
  assert.ok(isPrivatePath('examples/logos/x.svg'))
  assert.ok(!isPrivatePath('public/examples/edge-cases/aa-seam.svg'))
  assert.ok(!isPrivatePath('examples/logos-cc0/x.svg'))
})

test('flattened rows share ONE column set, with lists joined and nothing left undefined', () => {
  const d = run(emoji(2))
  d.rows[0].failedGates = ['chamfer', 'regions']
  d.rows[1].error = 'boom'
  d.rows[2].odd = 3
  d.rows[3].odd = 'three' // a mixed column is stringified throughout
  const flat = flattenRows(d, 'v9')
  const keys = Object.keys(flat[0])
  for (const r of flat) assert.deepEqual(Object.keys(r), keys)
  assert.deepEqual(keys.slice(0, 4), ['run', 'tool', 'corpus', 'caseId'])
  assert.equal(flat[0].failedGates, 'chamfer,regions')
  assert.equal(flat[0].run, 'v9')
  assert.equal(flat[0].caseLicense, 'CC-BY-4.0')
  assert.equal(flat[1].error, 'boom')
  assert.equal(flat[0].error, null)
  assert.equal(flat[2].odd, '3')
  assert.equal(flat[3].odd, 'three')
  assert.equal(typeof flat[0].meanDeltaE, 'number')
  const jsonl = toJsonl(flat)
  assert.equal(jsonl.trim().split('\n').length, d.rows.length)
  assert.ok(jsonl.endsWith('\n'))
})

test('the run index keeps one entry per run, newest first, and says the run has no renders', () => {
  const d = run(emoji(1))
  const a = { ...runEntry(d, 'v6', 1), date: '2026-10-01T00:00:00Z' }
  const b = { ...runEntry(d, 'v7', 2), date: '2026-10-20T00:00:00Z' }
  const merged = mergeRunIndex([a, { ...b, rows: 1 }], b)
  assert.deepEqual(
    merged.map((r) => r.name),
    ['v7', 'v6'],
  )
  assert.equal(merged[0].rows, d.rows.length)
  assert.equal(merged[0].renders, false)
  // What the page parses is what the publish writes.
  assert.deepEqual(parseRunIndex({ repo: 'x', runs: merged }), merged)
  assert.deepEqual(parseRunIndex({ runs: [{ name: 'ok' }, { bogus: 1 }, null] }), [
    { name: 'ok', date: null, corpora: [], tools: [], rows: 0, bytes: 0 },
  ])
  assert.deepEqual(parseRunIndex(null), [])
})

test('the card: front matter points the viewer at every run, and the leaderboard is held-out only', () => {
  const d = run([...emoji(12), { id: 'truth0/aa-seam', license: 'LogoLab fixture' }])
  const index = mergeRunIndex([{ ...runEntry(d, 'v6', 1), date: '2026-01-01T00:00:00Z' }], runEntry(d, 't', 1))
  const md = cardMarkdown({ data: d, run: 't', index, counts: { svgs: 3, truths: 1, overlays: 1, bytes: 1e6 } })
  const front = md.slice(0, md.indexOf('\n---\n', 4))
  assert.ok(front.startsWith('---\nlicense: other\n'))
  assert.match(
    front,
    /- config_name: "t"\n {2}data_files:\n {2}- split: test\n {4}path: "t\/results.jsonl"\n {2}default: true/,
  )
  assert.match(front, /- config_name: "v6"/)
  assert.equal((front.match(/default: true/g) ?? []).length, 1)
  assert.match(md, /### svgemoji-v0: fill art, 12 cases, 3 tools/)
  assert.doesNotMatch(md, /### truth0:/)
  assert.match(md, /Friedman/)
  assert.match(md, /Nemenyi CD/)
  assert.match(md, /Pareto win/)
  assert.match(md, /```bibtex/)
  assert.match(md, /this run has none/) // no CC-BY-SA case in it
  assert.doesNotMatch(md, /\*\*Trademarks\.\*\*/)
  const logos = run([{ id: 'logos-cc0/github', license: 'CC0-1.0' }])
  assert.match(
    cardMarkdown({ data: logos, run: 'l', index: [], counts: { svgs: 0, truths: 0, overlays: 0, bytes: 0 } }),
    /\*\*Trademarks\.\*\*/,
  )
  const sa = run([{ id: 'svgemoji/00A9-openmoji', license: 'CC-BY-SA-4.0' }])
  assert.match(
    cardMarkdown({ data: sa, run: 's', index: [], counts: { svgs: 0, truths: 0, overlays: 0, bytes: 0 } }),
    /This run includes CC-BY-SA 4.0 sources/,
  )
})

test('size categories follow the Hub’s buckets', () => {
  assert.equal(sizeCategory(999), 'n<1K')
  assert.equal(sizeCategory(2655), '1K<n<10K')
  assert.equal(sizeCategory(10000), '10K<n<100K')
})

test('sources: the page asks by the local path, and each source answers with its own layout', () => {
  const hub = hubSource()
  assert.equal(hub.runsUrl, `${HUB_BASE}runs.json`)
  assert.equal(LOCAL_SOURCE.runsUrl, '/__bench/runs')
  const dir = 'cases/svgemoji-v0/1f170-twemoji'
  // A run with renders: the PNG; without (a published run): the SVG, and truth.png is truth.svg.
  assert.equal(
    sourceUrl(LOCAL_SOURCE, 'v7', `${dir}/vtracer-default.png`),
    `/__bench/runs/v7/${dir}/vtracer-default.png`,
  )
  assert.equal(sourceUrl(hub, 'v7', `${dir}/vtracer-default.png`, false), `${HUB_BASE}v7/${dir}/vtracer-default.svg`)
  assert.equal(sourceUrl(hub, 'v7', `${dir}/truth.png`, false), `${HUB_BASE}v7/${dir}/truth.svg`)
  // The authored SVG: the dev plugin resolves the id; the hub has it staged next to the outputs.
  assert.equal(
    sourceUrl(LOCAL_SOURCE, 'v7', 'gt/svgemoji-v0/1f170-twemoji'),
    '/__bench/runs/v7/gt/svgemoji-v0/1f170-twemoji',
  )
  assert.equal(sourceUrl(hub, 'v7', 'gt/svgemoji-v0/1f170-twemoji', false), `${HUB_BASE}v7/${dir}/truth.svg`)
  assert.equal(sourceUrl(LOCAL_SOURCE, 'v7', 'manifests/svg-emoji-test.json'), '/__bench/manifest')
  assert.equal(sourceUrl(hub, 'v7', 'manifests/svg-emoji-test.json'), `${HUB_BASE}v7/manifests/svg-emoji-test.json`)
  assert.equal(sourceUrl(hub, 'v7', 'results.json'), `${HUB_BASE}v7/results.json`)
  // Segments are encoded, slashes kept.
  assert.equal(sourceUrl(hub, 'a b', 'cases/x/y#1.svg'), `${HUB_BASE}a%20b/cases/x/y%231.svg`)
})

test('a stand-in render takes the run’s raster box on its long side', () => {
  assert.deepEqual(renderBox(512, 1), { w: 512, h: 512 })
  assert.deepEqual(renderBox(512, 2), { w: 512, h: 256 })
  assert.deepEqual(renderBox(512, 0.5), { w: 256, h: 512 })
  assert.deepEqual(renderBox(512, Number.NaN), { w: 512, h: 512 })
})

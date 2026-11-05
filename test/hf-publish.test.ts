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
  attributionMarkdown,
  brokenTables,
  cardMarkdown,
  corpusOf,
  licensesMarkdown,
  localPaths,
  medianTable,
  missingLicenceTexts,
  publishable,
  safeCaseId,
  flattenRows,
  isPrivatePath,
  lineCorpusNotes,
  mergeRunIndex,
  publicResults,
  publishProblems,
  runEntry,
  sizeCategory,
  toJsonl,
} from '../bench/compare/hfCard.ts'
import { leaderboardMarkdown, plainMarkdown, summaryMarkdown } from '../bench/compare/report.ts'
import type { ScoreRow } from '../bench/compare/types.ts'

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

test('the allowlist is own keys and exact licence strings; a case id must be a plain <corpus>/<name>', () => {
  // Object.prototype is not an allowlist.
  assert.equal(publishable('constructor'), undefined)
  assert.equal(publishable('__proto__'), undefined)
  const proto = run([{ id: 'constructor/x', license: 'CC0-1.0' }])
  assert.ok(publishProblems(proto).some((x) => /corpus "constructor" is not on the publish allowlist/.test(x)))
  // strokes-oss takes the strings strokesOss.ts writes, not anything starting with MIT.
  assert.ok(PUBLISHABLE['strokes-oss'].licences.test('MIT (Feather)'))
  assert.ok(!PUBLISHABLE['strokes-oss'].licences.test('MIT'))
  assert.ok(!PUBLISHABLE['strokes-oss'].licences.test('MIT (microsoft/fluentui-emoji)'))
  // An id without a corpus, or one that climbs out of the staging directory, refuses.
  assert.equal(corpusOf('svgemoji-v0/x'), 'svgemoji-v0')
  assert.equal(corpusOf('nocorpus'), '')
  for (const id of ['nocorpus', 'truth0/../../x', 'truth0/a\\b', 'truth0/', 'truth0/./x', 'c:/x'])
    assert.ok(!safeCaseId(id), id)
  assert.ok(safeCaseId('svgemoji-v0/1f170-twemoji'))
  assert.ok(safeCaseId('strokes-oss/lucide/arrow-up'))
  const bad = run([...emoji(1), { id: 'truth0/../../../etc', license: 'LogoLab fixture' }])
  assert.ok(publishProblems(bad).some((x) => /not a plain <corpus>\/<name>/.test(x)))
})

test('a metric label with a pipe in it stays one cell, and a table that breaks is named', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `strokes-oss/lucide-${i}`).flatMap((id, i) =>
    ['logolab-strokes', 'autotrace-centerline', 'vtracer-default'].map((tool, t) =>
      row(tool, id, {
        heldOut: true,
        lane: 'line',
        meanDeltaE: t + i / 100,
        docNodes: 5 + t,
        clCentre: t,
        clMissed: t,
        clWidthErr: t,
        clPathsDelta: t,
        clTurns: t,
      }),
    ),
  )
  const board = leaderboardMarkdown(rows as unknown as ScoreRow[]).join('\n')
  const medians = medianTable(rows, 'strokes-oss', ['logolab-strokes']).join('\n')
  for (const md of [board, medians]) {
    assert.ok(md.includes('| \\|Paths Δ\\| ↓ |'), md.slice(0, 200))
    assert.deepEqual(brokenTables(md), [])
  }
  const d = run([{ id: 'strokes-oss/lucide-0', license: 'ISC (Lucide; portions MIT, Feather)' }], rows)
  const summary = summaryMarkdown(rows as unknown as ScoreRow[], d.meta as unknown as Record<string, unknown>)
  assert.ok(summary.includes('\\|ends Δ\\|'), 'the summary has a line table of its own')
  assert.deepEqual(brokenTables(summary), [])
  assert.deepEqual(brokenTables('| a | |b| |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n'), [
    'line 2 has 2 cells, its header 4',
    'line 3 has 2 cells, its header 4',
  ])
})

test('a line table says which rows are one output, whose strokes are no centrelines, and where a model recalls', () => {
  const stroked = { clMissed: 0, clPathsDelta: 0, clTurns: 0 }
  const rows = ['feather-a', 'feather-b', 'lucide-a', 'lucide-b'].flatMap((name) => {
    const id = `strokes-oss/${name}`
    const feather = name.startsWith('feather')
    return [
      row('logolab-strokes', id, { meanDeltaE: 0.4, bytes: 100, docNodes: 5, clCentre: 1, clWidthErr: 0, ...stroked }),
      row('logolab-auto', id, { meanDeltaE: 0.03, bytes: 200, docNodes: 9 }),
      row('logolab-outline', id, { meanDeltaE: 0.03, bytes: 200, docNodes: 9 }),
      row('imagetracer-default', id, {
        meanDeltaE: 0.1,
        bytes: 900,
        docNodes: 99,
        clCentre: 85,
        clWidthErr: 0.99,
        ...stroked,
      }),
      row('omnisvg-4b', id, { meanDeltaE: 3, bytes: 300, docNodes: 20 }),
      row('starvector-1b', id, {
        meanDeltaE: feather ? 0.1 : 4,
        bytes: 400,
        docNodes: 12,
        ...(feather ? { clCentre: 0.02, clWidthErr: 0, ...stroked } : {}),
      }),
    ]
  })
  const notes = lineCorpusNotes(rows, 'strokes-oss').join('\n')
  assert.match(notes, /`logolab-(auto|outline)` and `logolab-(auto|outline)`/)
  assert.doesNotMatch(notes, /`starvector-1b` and/, 'a different ΔE is a different output')
  assert.match(notes, /median centre distance 85 px, width error 0\.990/)
  assert.match(notes, /2 of 2 feather, 0 of 2 lucide/)
  assert.match(notes, /0\.02 px off/)
  assert.doesNotMatch(
    lineCorpusNotes(
      rows.filter((r) => !r.caseId.includes('feather')),
      'strokes-oss',
    ).join('\n'),
    /Feather/,
    'no Feather rows, no claim about them',
  )
})

test('a run that reused saved work says from which commit, and which bench files differ', () => {
  const counts = { svgs: 0, truths: 0, overlays: 0, bytes: 0 }
  const d = run(emoji(1))
  d.meta.progressFrom = [{ rev: '9b10d75', benchChanged: ['bench/compare/run.ts'] }]
  const md = cardMarkdown({ data: d, run: 'e', index: [], counts })
  assert.match(md, /reused traces and scores saved at 9b10d75/)
  assert.match(md, /`bench\/compare\/run\.ts`/)
  assert.doesNotMatch(cardMarkdown({ data: run(emoji(1)), run: 'e', index: [], counts }), /reused traces/)
})

test('a row renamed after scoring says what the commit still calls it', () => {
  const counts = { svgs: 0, truths: 0, overlays: 0, bytes: 0 }
  const d = run(emoji(1))
  d.meta.renamed = { 'logolab-product': 'logolab-abl-stacked-grad' }
  assert.match(
    cardMarkdown({ data: d, run: 'e', index: [], counts }),
    /commit abc1234 still calls `logolab-abl-stacked-grad` `logolab-product`/,
  )
  assert.doesNotMatch(cardMarkdown({ data: run(emoji(1)), run: 'e', index: [], counts }), /still calls/)
})

test('the ablation view is collapsed, and its table is set off so it still renders', () => {
  const rows = Array.from({ length: 12 }, (_, i) => `logos-cc0/mark-${i}`).flatMap((id, i) =>
    ['logolab-auto', 'vtracer-default', 'logolab-abl-stacked-grad'].map((tool, t) =>
      row(tool, id, {
        heldOut: true,
        meanDeltaE: t + i / 100,
        chamfer: t,
        docNodes: 5 + t,
        tangentBreaks: t,
        sbDino: 1 - t / 10,
      }),
    ),
  )
  const lines = leaderboardMarkdown(rows as unknown as ScoreRow[])
  const open = lines.indexOf('<details>')
  assert.ok(open > 0, lines.join('\n').slice(0, 300))
  assert.equal(lines[open - 1], '', 'a blank line before the block')
  assert.match(lines[open + 1], /^<summary>Ablation view \(not the headline; 3 rows, /)
  assert.equal(lines[open + 2], '', 'a blank line before the table')
  assert.equal(lines[lines.indexOf('</details>') - 1], '', 'a blank line after the table')
  assert.ok(lines.slice(open).some((l) => l.includes('logolab-abl-stacked-grad ◇')))
  assert.ok(!lines.slice(0, open).some((l) => l.includes('logolab-abl-stacked-grad')), 'never in the headline table')
  assert.deepEqual(brokenTables(lines.join('\n')), [])
})

test('a run with a line corpus documents the centreline columns by their agreed names', () => {
  const d = run([{ id: 'strokes-oss/lucide-bell', license: 'ISC (Lucide; portions MIT, Feather)' }])
  const md = cardMarkdown({ data: d, run: 's', index: [], counts: { svgs: 0, truths: 0, overlays: 0, bytes: 0 } })
  for (const k of ['clCentre', 'clCentreP95', 'clMissed', 'clWidthErr', 'clEndsDelta', 'clPathsDelta', 'clTurns'])
    assert.ok(md.includes(`\`${k}\``), k)
  assert.match(md, /\n- line-art\n/)
  assert.doesNotMatch(
    cardMarkdown({ data: run(emoji(1)), run: 'e', index: [], counts: { svgs: 0, truths: 0, overlays: 0, bytes: 0 } }),
    /Centreline metrics/,
  )
})

test('a local path never ships: the recorded one is taken out, and any other stops the publish', () => {
  const d = run(emoji(1))
  d.meta.provenance = {
    git: { rev: 'abc' },
    starvector: { model: 'm', reportFrom: 'E:\\work\\report.json', gpu: 'g' },
    omnisvg: null,
  }
  assert.ok(publishProblems(d).some((p) => p.includes('$.meta.provenance.starvector.reportFrom')))
  const pub = publicResults(d)
  assert.deepEqual(publishProblems(pub), [])
  assert.deepEqual(pub.meta.provenance?.starvector, { model: 'm', gpu: 'g' })
  assert.equal(
    JSON.stringify(pub),
    JSON.stringify(d).replace(',"reportFrom":"E:\\\\work\\\\report.json"', ''),
    'nothing else moves',
  )
  d.rows[0] = { ...d.rows[0], error: 'could not read /home/someone/x.svg' }
  assert.ok(publishProblems(publicResults(d)).some((p) => p.endsWith('.error holds a local path')))
  for (const fine of ['bench/compare/run.ts', 'https://github.com/a/b', 'stroked geometry (path)', 'mono (cut at 128)'])
    assert.deepEqual(localPaths(fine), [], fine)
  assert.deepEqual(publishProblems(publicResults(run(emoji(1)))), [], 'a run with no provenance is untouched')
})

test('the published prose has no dashes or curly quotes, whatever a row recorded', () => {
  const rows = emoji(12)
  const d = run(rows)
  const refused = 'masked geometry (path) — the visible boundary is the mask’s alpha'
  d.rows[0] = { ...d.rows[0], gtRefusal: refused }
  d.rows[1] = { ...d.rows[1], geomRefusal: refused }
  const counts = { svgs: 0, truths: 0, overlays: 0, bytes: 0 }
  const files = {
    card: cardMarkdown({ data: d, run: 't', index: [], counts }),
    licences: licensesMarkdown(d),
    attribution: attributionMarkdown('abc'),
    summary: summaryMarkdown(d.rows as unknown as ScoreRow[], d.meta as unknown as Record<string, unknown>),
  }
  for (const [name, md] of Object.entries(files)) assert.doesNotMatch(md, /[—–‘’“”]/, name)
  assert.equal(plainMarkdown('a — b’s “c” 0–1'), 'a: b\'s "c" 0-1')
})

test('MIT and ISC texts ship with the copies, verbatim, and a missing one is named', () => {
  const d = run([
    { id: 'strokes-oss/feather-bell', license: 'MIT (Feather)' },
    { id: 'logos-cc0/github', license: 'CC0-1.0' },
    { id: 'svgemoji-v0/1f600', license: 'CC-BY-4.0' },
  ])
  assert.deepEqual(missingLicenceTexts(d, []), ['MIT (Feather)'], 'CC0 and CC-BY need no text')
  const texts = [{ licence: 'MIT (Feather)', title: 'feather-icons 4.29.2', text: 'Copyright — Cole Bemis\n' }]
  assert.deepEqual(missingLicenceTexts(d, texts), [])
  const md = licensesMarkdown(d, texts)
  assert.match(md, /## Licence texts\n\n### feather-icons 4\.29\.2\n\n```text\nCopyright — Cole Bemis\n```/)
  assert.doesNotMatch(licensesMarkdown(d), /see below/)
})

test('a tool with no geometry anywhere does not empty the common-cases line', () => {
  const cases = emoji(12)
  const d = run(
    cases,
    cases.flatMap((c, i) => [
      row('logolab-auto', c.id, { chamfer: 1, p95: 2, nodeRatio: 1, tangentBreaks: 0, meanDeltaE: i }),
      row('vtracer-default', c.id, { chamfer: 3, p95: 4, nodeRatio: 2, tangentBreaks: 5, meanDeltaE: i }),
      row('imagetracer-default', c.id, { meanDeltaE: i, geomRefusal: 'stroked geometry' }),
    ]),
  )
  const md = summaryMarkdown(d.rows as unknown as ScoreRow[], d.meta as unknown as Record<string, unknown>)
  assert.match(
    md,
    /Common cases \(12\/12, where every tool with n ≥ 10 and any geometry has it; no geometry at all: imagetracer-default\)/,
  )
  assert.match(md, /logolab-auto 1\.00 \/ 2\.00 \/ 1\.0 \/ 0; vtracer-default 3\.00/)
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
  assert.match(front, /^license_link: https:\/\/\S+\/LICENSES\.md$/m, 'the Hub refuses any relative name but LICENSE')
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

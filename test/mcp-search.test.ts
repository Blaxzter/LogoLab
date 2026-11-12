// The MCP `search` option (src/mcp/trace.ts): trace every way the request leaves
// open, score each candidate against the source with the shipped ΔE, and keep the
// probes' own pick unless another candidate is clearly closer.
//
//   node --test test/mcp-search.test.ts
//
// The candidates' order and labels and the winner rule's core are the studio's
// "Find best settings" (lib/traceInput/bestSettings.ts, test/best-settings.test.ts);
// this gates what the MCP adds: which candidates a request leaves open, the
// relative margin, the probes' pick as the incumbent, and that the SVG it returns
// is exactly what `trace_icon` returns for the winning request — the search picks
// a request, it never makes a new kind of trace.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CANDIDATE_ORDER, SIMPLER_WINS_DE, type CandidateScore } from '../src/lib/traceInput/bestSettings.ts'
import { loadSource, pngFrom, renderSvg } from '../src/mcp/image.ts'
import { ensureImageData } from '../src/mcp/runtime.ts'
import { createServer } from '../src/mcp/server.ts'
import {
  candidateOf,
  pickSearchWinner,
  runCandidate,
  SEARCH_BY_DEFAULT,
  SEARCH_CANDIDATES,
  searchCandidates,
  searchMargin,
  traceIcon,
} from '../src/mcp/trace.ts'

ensureImageData()

const dir = mkdtempSync(join(tmpdir(), 'logolab-search-'))

/** A small PNG of `svg` (on white when `bg` is given): small, so every candidate traces fast. */
function fixture(name: string, svg: string, bg?: string, size = 96): string {
  const path = join(dir, `${name}.png`)
  writeFileSync(path, pngFrom(renderSvg(svg, size, bg)))
  return path
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">${body}</svg>`
/** A purple plate with a white disc on it, on white: one ink on paper to the probe. */
const PLATE = fixture(
  'plate',
  svg('<rect x="8" y="8" width="80" height="80" rx="18" fill="#5b2a86"/><circle cx="48" cy="48" r="20" fill="#fff"/>'),
  '#ffffff',
)
/** A black disc on white: the textbook mono mark. */
const DISC = fixture('disc', svg('<circle cx="48" cy="48" r="34" fill="#111111"/>'), '#ffffff')

/* ------------------------------------------------------------- candidates */

test('the search is on unless turned off (the default is one switch, and it is on)', () => {
  assert.equal(SEARCH_BY_DEFAULT, true)
})

test('the candidates are what the request leaves open, simplest first', () => {
  assert.deepEqual(searchCandidates({}), ['mono', 'flat', 'gradients'])
  assert.deepEqual(searchCandidates({ mode: 'auto', gradients: 'auto' }), ['mono', 'flat', 'gradients'])
  assert.deepEqual(searchCandidates({ mode: 'color' }), ['flat', 'gradients'])
  assert.deepEqual(searchCandidates({ gradients: 'flat' }), ['mono', 'flat'])
  assert.deepEqual(searchCandidates({ gradients: 'rich' }), ['mono', 'gradients'])
  // Mono decides nothing about gradients, so a forced mono leaves nothing to search.
  assert.deepEqual(searchCandidates({ mode: 'mono' }), ['mono'])
  assert.deepEqual(searchCandidates({ mode: 'color', gradients: 'flat' }), ['flat'])
  // Strokes paint flat inks in colour too: mono strokes vs colour strokes.
  assert.deepEqual(searchCandidates({ strokes: true }), ['strokes', 'flat'])
  for (const req of [{}, { mode: 'color' as const }, { strokes: true }]) {
    const ids = searchCandidates(req)
    assert.deepEqual(
      ids,
      CANDIDATE_ORDER.filter((id) => ids.includes(id)),
      'the order is the studio tie-break order',
    )
  }
})

test('mono is traced only where one ink could draw the art, or the probes picked it', () => {
  assert.deepEqual(searchCandidates({}, { inks: 1, pick: 'flat' }), ['mono', 'flat', 'gradients'])
  assert.deepEqual(searchCandidates({}, { inks: 4, pick: 'gradients' }), ['flat', 'gradients'])
  assert.deepEqual(searchCandidates({}, { inks: 2, pick: 'mono' }), ['mono', 'flat', 'gradients'])
  assert.deepEqual(searchCandidates({ strokes: true }, { inks: 3, pick: 'flat' }), ['flat'])
})

test('each candidate pins exactly the choices it stands for, and a plan maps back to one', () => {
  assert.deepEqual(SEARCH_CANDIDATES.mono, { mode: 'mono' })
  assert.deepEqual(SEARCH_CANDIDATES.flat, { mode: 'color', gradients: 'flat' })
  assert.deepEqual(SEARCH_CANDIDATES.gradients, { mode: 'color', gradients: 'rich' })
  assert.equal(candidateOf({ mode: 'mono', gradients: true, strokes: false }), 'mono')
  assert.equal(candidateOf({ mode: 'mono', gradients: false, strokes: true }), 'strokes')
  assert.equal(candidateOf({ mode: 'color', gradients: false, strokes: false }), 'flat')
  assert.equal(candidateOf({ mode: 'color', gradients: true, strokes: false }), 'gradients')
  assert.equal(candidateOf({ mode: 'color', gradients: true, strokes: true }), 'flat')
})

/* -------------------------------------------------------------- the rule */

const s = (id: CandidateScore['id'], meanDeltaE: number, nodes = 10): CandidateScore => ({ id, meanDeltaE, nodes })

test('the margin is relative with a small floor', () => {
  assert.ok(searchMargin(0) > 0, 'two near-perfect traces do not trade places on noise')
  assert.ok(searchMargin(1) > searchMargin(0.1))
  // At bench scale the studio's absolute 0.3 would call a five-fold error a tie.
  assert.ok(searchMargin(0.033) < 0.186 - 0.033)
  assert.ok(searchMargin(0.1) < SIMPLER_WINS_DE)
})

test("the probes' pick stays while it is within the margin of the closest", () => {
  const best = 0.1
  const near = best + searchMargin(best) * 0.9
  assert.equal(pickSearchWinner([s('mono', near), s('flat', best), s('gradients', best)], 'mono')[0].id, 'mono')
  assert.equal(pickSearchWinner([s('flat', best), s('gradients', near)], 'gradients')[0].id, 'gradients')
})

test("outside the margin the probes' pick is overruled: the simplest within the margin of the closest wins", () => {
  const best = 0.1
  const far = best + searchMargin(best) + 0.01
  assert.equal(pickSearchWinner([s('mono', far), s('flat', best), s('gradients', best)], 'mono')[0].id, 'flat')
  assert.equal(pickSearchWinner([s('mono', far), s('flat', far), s('gradients', best)], 'mono')[0].id, 'gradients')
})

test('the three probe misfires of the svgemoji benchmark are overruled (production-raster scores)', () => {
  // 1f4f3: the probe traced inverted mono.
  assert.equal(pickSearchWinner([s('mono', 0.186), s('flat', 0.058), s('gradients', 0.033)], 'mono')[0].id, 'gradients')
  // 2615: gradients on flat art (four inks, so no mono candidate).
  assert.equal(pickSearchWinner([s('flat', 0.063), s('gradients', 0.251)], 'gradients')[0].id, 'flat')
  // 1fab1: one ink plus gradients.
  assert.equal(pickSearchWinner([s('mono', 2.648), s('flat', 0.133), s('gradients', 0.194)], 'gradients')[0].id, 'flat')
})

test('a failed candidate never wins, and nothing scored means no winner', () => {
  assert.equal(pickSearchWinner([s('mono', Number.NaN), s('flat', 2)], 'mono')[0].id, 'flat')
  assert.deepEqual(pickSearchWinner([]), [])
})

/* ------------------------------------------------------------ the search */

test('search traces every open candidate and returns exactly the winning request’s SVG', async () => {
  const src = loadSource(PLATE)
  const plain = await traceIcon(src, { search: false })
  const found = await traceIcon(src, { search: true })
  const report = found.plan.search
  assert.ok(report, 'the plan carries the scoreboard')
  assert.deepEqual(report.candidates.map((c) => c.id).sort(), ['flat', 'gradients', 'mono'], 'one ink: mono too')
  assert.equal(report.probed, candidateOf(plain.plan), 'the incumbent is what the probes alone traced')
  assert.equal(report.winner, report.candidates[0].id)
  for (const c of report.candidates) assert.ok(Number.isFinite(c.meanDeltaE) && c.nodes > 0, c.id)
  // The winner is the rule applied to the reported scores, nothing else.
  assert.equal(pickSearchWinner(report.candidates, report.probed)[0].id, report.winner)
  assert.match(found.plan.summary, new RegExp(`searched 3 candidates by ΔE at 96px, ${report.winner} won`))

  // The search picks a REQUEST: the SVG is what trace_icon returns with the winner's choices pinned,
  // and when the probes' pick stands it is the plain trace itself.
  const pinned = await traceIcon(src, SEARCH_CANDIDATES[report.winner])
  assert.equal(found.svg, pinned.svg)
  assert.equal(found.plan.mode, pinned.plan.mode)
  assert.equal(found.plan.gradients, pinned.plan.gradients)
  if (report.winner === report.probed) assert.equal(found.svg, plain.svg)
})

test('without search, the probes decide and no scoreboard is reported; with nothing said, it searches', async () => {
  const src = loadSource(PLATE)
  const plain = await traceIcon(src, { search: false })
  assert.equal(plain.plan.search, null)
  assert.doesNotMatch(plain.plan.summary, /searched/)
  const unsaid = await traceIcon(src)
  assert.ok(unsaid.plan.search, 'the default searches')
  assert.equal(unsaid.svg, (await traceIcon(src, { search: true })).svg)
})

test('a request that pins every choice has nothing to search: same SVG, no scoreboard', async () => {
  const src = loadSource(DISC)
  const req = { mode: 'color' as const, gradients: 'flat' as const }
  const searched = await traceIcon(src, { ...req, search: true })
  assert.equal(searched.plan.search, null)
  assert.equal(searched.svg, (await traceIcon(src, req)).svg)
})

test('a mono candidate is scored in the ink it was drawn in, not the ink it is painted', async () => {
  const src = loadSource(DISC)
  const plain = await runCandidate(src, {}, 'mono')
  const red = await runCandidate(src, { ink: '#ff0000' }, 'mono')
  assert.equal(red.meanDeltaE, plain.meanDeltaE, 'asking for red paint does not make mono look worse')
  assert.match(red.run.traced.svg, /#ff0000/)
})

/* ------------------------------------------------------------ the surface */

test('trace_icon and make_app_icons take `search`; inspect_icon, which never traces, does not', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await server.server.connect(serverTransport)
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  const has = (name: string) => 'search' in (tools.find((t) => t.name === name)?.inputSchema.properties ?? {})
  assert.ok(has('trace_icon'))
  assert.ok(has('make_app_icons'))
  assert.ok(!has('inspect_icon'))

  const result = (await client.callTool({
    name: 'trace_icon',
    arguments: { image: DISC, out: join(dir, 'disc.svg'), search: true },
  })) as { content: { type: string; text: string }[]; isError?: boolean }
  assert.ok(!result.isError, result.content[0]?.text)
  const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.content[0].text)?.[1] ?? '{}')
  assert.ok(json.plan.search, 'the tool reports the scoreboard')
  assert.match(result.content[0].text, /searched \d candidates by ΔE/)
})

// split_icon_sheet as an icon-set tool (src/mcp/sheet.ts, src/mcp/server.ts):
//
//   node --test test/mcp-sheet.test.ts
//
// An agent that drove the splitter over ten sheets for an evening wrote down
// what it had to work around; each test here is one of those items, over the
// real protocol. A synthetic sheet stands in: one icon drawn as four corner
// brackets further apart than its neighbours (the case a `gap` cannot express),
// three solid marks beside it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { encodePng } from '../src/lib/png/encode.ts'
import { createServer } from '../src/mcp/server.ts'
import { fileStem, SHEET_MANIFEST, snapInk, unifyInk, type SheetReport } from '../src/mcp/sheet.ts'

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await server.server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
}

function jsonOf(result: unknown): SheetReport {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result))
  assert.ok(match, 'the result carries a JSON block')
  return JSON.parse(match[1]) as SheetReport
}

/** 620×170 white sheet: four 24px brackets 56px apart (one icon), then three 104px squares 46px apart. */
function writeSheet(dir: string, ink: [number, number, number] = [0, 0, 0]): string {
  const w = 620
  const h = 170
  const rgba = new Uint8Array(w * h * 4).fill(255)
  const paint = (x0: number, y0: number, size: number) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const o = (y * w + x) * 4
        rgba[o] = ink[0]
        rgba[o + 1] = ink[1]
        rgba[o + 2] = ink[2]
      }
    }
  }
  for (const [x, y] of [
    [30, 30],
    [110, 30],
    [30, 110],
    [110, 110],
  ]) {
    paint(x, y, 24)
  }
  for (const x of [180, 330, 480]) paint(x, 30, 104)
  const path = join(dir, 'sheet.png')
  writeFileSync(path, encodePng(rgba, w, h))
  return path
}

const tmp = () => mkdtempSync(join(tmpdir(), 'logolab-sheet-'))

test('grid hint + names + normalize + currentColor: icon-set files in one call', async () => {
  const client = await connect()
  const dir = tmp()
  const sheet = writeSheet(dir)
  const out = join(dir, 'icons')
  const result = await client.callTool({
    name: 'split_icon_sheet',
    arguments: {
      sheet,
      outDir: out,
      grid: { rows: 1, cols: 4 },
      names: ['brackets', 'alpha', 'beta', 'gamma'],
      normalize: 24,
      ink: 'currentColor',
    },
  })
  assert.ok(!(result as { isError?: boolean }).isError, textOf(result))
  const report = jsonOf(result)

  assert.deepEqual(report.grid, { rows: 1, cols: 4 })
  assert.deepEqual(
    report.icons.map((i) => i.svgPath),
    ['brackets.svg', 'alpha.svg', 'beta.svg', 'gamma.svg'],
  )
  assert.deepEqual(
    report.icons.map((i) => [i.row, i.col]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  )
  for (const icon of report.icons) {
    const svg = readFileSync(join(out, icon.svgPath), 'utf8')
    assert.match(svg, /viewBox="0 0 24 24"/, icon.svgPath)
    assert.match(svg, /fill="currentColor"/, icon.svgPath)
    assert.ok(!/id="paper"|fill="#ffffff"/.test(svg), `${icon.svgPath} has no paper: tiles are transparent by default`)
    assert.equal(icon.mode, 'mono')
    assert.equal(icon.ink, 'currentColor')
    assert.equal(icon.stats.colors, 1, `${icon.svgPath}: one colour, not the paper too`)
    assert.ok(!/\d\.\d{3}/.test(svg), `${icon.svgPath} is rounded to two decimals`)
  }
  // The brackets are one icon, fitted as one: its ink reaches the inset on both axes.
  const brackets = readFileSync(join(out, 'brackets.svg'), 'utf8')
  const xs = [...brackets.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
  assert.ok(xs.length >= 16, 'four brackets worth of corners')
  assert.ok(Math.min(...xs.map((p) => p[0])) >= 1.9 && Math.min(...xs.map((p) => p[0])) <= 2.1)
  assert.ok(Math.max(...xs.map((p) => p[0])) >= 21.9 && Math.max(...xs.map((p) => p[0])) <= 22.1)

  // The run is on record.
  const manifest = JSON.parse(readFileSync(join(out, SHEET_MANIFEST), 'utf8')) as {
    runs: Record<string, { files: string[] }>
  }
  assert.deepEqual(manifest.runs.sheet.files, ['brackets.svg', 'alpha.svg', 'beta.svg', 'gamma.svg'])
})

test('a re-run into the same directory removes what it no longer produces; a limited run removes nothing', async () => {
  const client = await connect()
  const dir = tmp()
  const sheet = writeSheet(dir)
  const out = join(dir, 'icons')
  const first = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: out, grid: { rows: 1, cols: 4 }, names: ['a', 'b', 'c', 'd'], keepCrops: true },
  })
  assert.ok(!(first as { isError?: boolean }).isError, textOf(first))
  assert.ok(existsSync(join(out, 'a.svg')) && existsSync(join(out, 'a.png')))

  // A preview: nothing of the full run is touched.
  const preview = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: out, grid: { rows: 1, cols: 4 }, limit: 1 },
  })
  assert.deepEqual(jsonOf(preview).removed, [])
  assert.ok(existsSync(join(out, 'd.svg')))

  // The real re-run, named by position now: the four named files (and their crops) go.
  const second = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: out, grid: { rows: 1, cols: 4 } },
  })
  const report = jsonOf(second)
  assert.deepEqual(
    report.icons.map((i) => i.svgPath),
    ['sheet-01.svg', 'sheet-02.svg', 'sheet-03.svg', 'sheet-04.svg'],
  )
  assert.deepEqual(report.removed.sort(), ['a.png', 'a.svg', 'b.png', 'b.svg', 'c.png', 'c.svg', 'd.png', 'd.svg'])
  assert.ok(!existsSync(join(out, 'a.svg')))
  assert.ok(existsSync(join(out, 'sheet-04.svg')))
  assert.match(textOf(second), /Removed 8 stale file/)

  // Stale files are only ever the tool's own: a stranger in the directory stays.
  const stranger = join(out, 'notes.svg')
  writeFileSync(stranger, '<svg/>')
  await client.callTool({ name: 'split_icon_sheet', arguments: { sheet, outDir: out, grid: { rows: 1, cols: 4 } } })
  assert.ok(existsSync(stranger))
})

test('quiet returns the per-icon summary and no JSON; a bad ink is an error the agent can read', async () => {
  const client = await connect()
  const dir = tmp()
  const sheet = writeSheet(dir)
  const quiet = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: join(dir, 'q'), grid: { rows: 1, cols: 4 }, quiet: true },
  })
  const text = textOf(quiet)
  assert.ok(!/```json/.test(text), 'no JSON block')
  assert.match(text, /sheet-01\.svg {2}r0c0 {2}mono/)
  assert.match(text, /sheet-04\.svg {2}r0c3/)

  const bad = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: join(dir, 'bad'), ink: 'blackish' },
  })
  assert.equal((bad as { isError?: boolean }).isError, true)
  assert.match(textOf(bad), /ink/)
})

test('one ink per sheet: JPEG-noise inks are written as the sheet ink, snapped to pure black', async () => {
  const client = await connect()
  const dir = tmp()
  // Every mark is #020202 — what a JPEG makes of black.
  const sheet = writeSheet(dir, [2, 2, 2])
  const result = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: join(dir, 'ink'), grid: { rows: 1, cols: 4 } },
  })
  const report = jsonOf(result)
  assert.equal(report.ink, '#000000')
  for (const icon of report.icons) assert.equal(icon.ink, '#000000')
  const svg = readFileSync(join(dir, 'ink', 'sheet-02.svg'), 'utf8')
  assert.match(svg, /fill="#000000"/)
  assert.ok(!/fill="#020202"/.test(svg))
  assert.equal(typeof report.icons[1].inkThickness, 'number', 'the stroke weight is reported for a fill trace')

  // An explicit ink beats the sheet's.
  const navy = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: join(dir, 'navy'), grid: { rows: 1, cols: 4 }, ink: '#1F2937', limit: 1 },
  })
  assert.equal(jsonOf(navy).icons[0].ink, '#1f2937')
  assert.match(readFileSync(join(dir, 'navy', 'sheet-01.svg'), 'utf8'), /fill="#1f2937"/)
})

test('the paper can be kept, and then the tile is a page under the ink', async () => {
  const client = await connect()
  const dir = tmp()
  const sheet = writeSheet(dir)
  const result = await client.callTool({
    name: 'split_icon_sheet',
    arguments: { sheet, outDir: join(dir, 'paper'), grid: { rows: 1, cols: 4 }, removeBackground: false, limit: 1 },
  })
  const report = jsonOf(result)
  const svg = readFileSync(join(dir, 'paper', report.icons[0].svgPath), 'utf8')
  assert.match(svg, /fill="#ffffff"/, 'the paper rectangle is there')
  assert.equal(report.icons[0].stats.colors, 2)
})

test('trace_icon takes the same ink and normalize', async () => {
  const client = await connect()
  const dir = tmp()
  const sheet = writeSheet(dir)
  const out = join(dir, 'one.svg')
  const result = await client.callTool({
    name: 'trace_icon',
    arguments: { image: sheet, out, normalize: 48, inset: 4, ink: 'currentColor', removeBackground: true, quiet: true },
  })
  assert.ok(!(result as { isError?: boolean }).isError, textOf(result))
  assert.ok(!/```json/.test(textOf(result)))
  assert.match(textOf(result), /fitted to a 48×48 viewBox, inset 4/)
  const svg = readFileSync(out, 'utf8')
  assert.match(svg, /viewBox="0 0 48 48"/)
  assert.match(svg, /fill="currentColor"/)
})

test('ink unification and file stems, on their own', () => {
  assert.equal(unifyInk('#010101', '#000000'), '#000000')
  assert.equal(unifyInk('#020202', '#030303'), '#000000')
  assert.equal(unifyInk('#1e1b4b', '#000000'), '#1e1b4b', 'navy is not black')
  assert.equal(unifyInk('#1f2937', '#111827'), '#111827', 'the same dark ink under noise is written once')
  assert.equal(unifyInk(null, '#000000'), null)
  assert.equal(snapInk('#fdfefe'), '#ffffff')
  assert.equal(snapInk('#808080'), '#808080')
  assert.equal(fileStem(' Fit Screen '), 'Fit-Screen')
  assert.equal(fileStem('a/b:c*d'), 'a-b-c-d')
  assert.equal(fileStem(undefined), '')
})

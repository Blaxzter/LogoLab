// The MCP server's edges — the inputs real agents and real projects hand it that
// the happy-path tests (mcp-icons, mcp-server) never did.
//
//   node --test test/mcp-edges.test.ts
//
// Each test is one bug that shipped in 0.3.0: an authored SVG that export_icons
// refused, a `gradients: 'flat'` that was ignored, a trace written over its own
// source, a README.md clobbered at a project root, a colour name that wiped a
// channel, a VS Code config VS Code never reads, a bare `npx` Windows clients
// cannot spawn, and web presets that overwrote each other's manifest.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { decodePng } from '../src/lib/png/decode.ts'
import { exportCollection, NOTES_FILE } from '../src/mcp/export.ts'
import { flattenOnto, loadSource, parseHexColor } from '../src/mcp/image.ts'
import { configPath, launchSpec, vscodeUserDir } from '../src/mcp/install.ts'
import { prepareSource, prepareVector, renderIconPng } from '../src/mcp/render.ts'
import { ensureImageData } from '../src/mcp/runtime.ts'
import { createServer, defaultSvgPath } from '../src/mcp/server.ts'
import { planTrace, withGradientMode } from '../src/mcp/trace.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'

ensureImageData()

const SQUARE = '<rect x="0" y="0" width="24" height="24" fill="#e11d48"/>'
const BASE = { background: 'transparent', shape: 'square' as const, radiusPct: 24, paddingPct: 0, scale: 1 }

/** Fraction of a rendered icon's pixels that carry ink. */
function coverage(png: Uint8Array): number {
  const img = decodePng(png)
  let ink = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 128) ink++
  return ink / (img.width * img.height)
}

test('an authored SVG with its own width/height/x/y/preserveAspectRatio renders (no duplicate attributes)', () => {
  const cases = [
    // Lucide / Figma: width + height + viewBox.
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${SQUARE}</svg>`,
    // Every placed attribute, single-quoted for good measure.
    `<svg xmlns="http://www.w3.org/2000/svg" x='0' y='0' width='24' height='24' preserveAspectRatio='none' viewBox='0 0 24 24'>${SQUARE}</svg>`,
    // No viewBox: width/height set the user space, so dropping them must not shrink the art.
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">${SQUARE}</svg>`,
  ]
  for (const svg of cases) {
    const png = renderIconPng(prepareVector(svg, 24, 24), { ...BASE, size: 64 })
    assert.ok(coverage(png) > 0.95, `full-bleed square fills the icon: ${svg.slice(0, 80)}`)
  }
  // An attribute that merely ENDS in a placed name is not touched.
  const stroked = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" stroke-width="2" viewBox="0 0 24 24">${SQUARE}</svg>`
  assert.match(prepareVector(stroked, 24, 24).place({ x: 0, y: 0, width: 10, height: 10 }), /stroke-width="2"/)
})

test('export_icons takes the repo’s own orbit.svg (root width/height)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-edges-'))
  const report = exportCollection(await prepareSource(loadSource('public/examples/orbit.svg')), out, {
    presets: ['favicon'],
  })
  assert.ok(report.files.length > 0)
  assert.ok(existsSync(join(out, 'public/favicon.ico')))
})

test("gradients 'flat' / 'rich' are honoured, as the sheet's control maps them", async () => {
  assert.equal(withGradientMode({ ...DEFAULT_VECTORIZE_OPTIONS, gradients: true }, 'flat').gradients, false)
  assert.equal(withGradientMode({ ...DEFAULT_VECTORIZE_OPTIONS, gradients: false }, 'rich').gradients, true)
  const base = { ...DEFAULT_VECTORIZE_OPTIONS }
  assert.equal(withGradientMode(base, 'auto'), base, 'auto leaves the decision to the probe')

  const src = loadSource('public/examples/nebula.png')
  const flat = await planTrace(src, { mode: 'color', gradients: 'flat' })
  const rich = await planTrace(src, { mode: 'color', gradients: 'rich' })
  assert.equal(flat.plan.gradients, false)
  assert.match(flat.plan.summary, /gradients off/)
  assert.equal(rich.plan.gradients, true)
  assert.ok(flat.plan.rasterCap > rich.plan.rasterCap, 'flat traces at the flat cap')
})

test('re-tracing an .svg never defaults to writing over the source', () => {
  const dir = join(tmpdir(), 'proj')
  assert.equal(defaultSvgPath(join(dir, 'logo.png')), join(dir, 'logo.svg'))
  assert.equal(defaultSvgPath(join(dir, 'logo.svg')), join(dir, 'logo.traced.svg'))
})

test('the export notes do not overwrite a project README', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-edges-'))
  writeFileSync(join(out, 'README.md'), '# My project\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${SQUARE}</svg>`
  const report = exportCollection(prepareVector(svg, 24, 24), out, { presets: ['tauri'] })
  assert.equal(readFileSync(join(out, 'README.md'), 'utf8'), '# My project\n')
  assert.ok(existsSync(join(out, NOTES_FILE)))
  assert.ok(!report.files.some((f) => f.path === 'README.md'))
})

test('flattenOnto takes hex only — a colour name is an error, not a wiped channel', async () => {
  assert.deepEqual(parseHexColor('#fff'), [255, 255, 255])
  assert.deepEqual(parseHexColor('1E90ff'), [30, 144, 255])
  for (const bad of ['red', 'black', 'transparent', 'rgb(0,0,0)', '#12345', '#ggg'])
    assert.throws(() => parseHexColor(bad), /not a hex colour/, bad)

  const opaque = { width: 1, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255]) }
  assert.deepEqual([...flattenOnto(opaque, '#000').data], [200, 100, 50, 255])

  // The tool schema refuses it before anything is traced.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await createServer().server.connect(serverTransport)
  await client.connect(clientTransport)
  const result = (await client.callTool({
    name: 'inspect_icon',
    arguments: { image: 'public/examples/petals.png', flattenOnto: 'red' },
  })) as { isError?: boolean }
  assert.equal(result.isError, true)
})

test('VS Code user scope writes the profile’s User/mcp.json, not ~/.vscode', () => {
  const home = join('/', 'home', 'u')
  assert.equal(
    vscodeUserDir('win32', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home),
    join('C:\\Users\\u\\AppData\\Roaming', 'Code', 'User'),
  )
  assert.equal(vscodeUserDir('darwin', {}, home), join(home, 'Library', 'Application Support', 'Code', 'User'))
  assert.equal(vscodeUserDir('linux', {}, home), join(home, '.config', 'Code', 'User'))
  assert.equal(vscodeUserDir('linux', { XDG_CONFIG_HOME: '/xdg' }, home), join('/xdg', 'Code', 'User'))
  const user = configPath('vscode', 'user', '/tmp/project')
  assert.match(user, /Code[\\/]User[\\/]mcp\.json$/)
  assert.doesNotMatch(user, /\.vscode/)
})

test('the published launch command goes through cmd /c on Windows only', () => {
  assert.deepEqual(launchSpec('win32', false), { command: 'cmd', args: ['/c', 'npx', '-y', 'logolab'] })
  assert.deepEqual(launchSpec('linux', false), { command: 'npx', args: ['-y', 'logolab'] })
  assert.deepEqual(launchSpec('darwin', false), { command: 'npx', args: ['-y', 'logolab'] })
  assert.equal(launchSpec('win32', true).command, 'node', 'a checkout runs node.exe directly')
})

test('pwa + favicon: one manifest over the union, each path reported once', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-edges-'))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${SQUARE}</svg>`
  const report = exportCollection(prepareVector(svg, 24, 24), out, { presets: ['pwa', 'favicon'] })

  const manifest = JSON.parse(readFileSync(join(out, 'public/manifest.webmanifest'), 'utf8')) as {
    icons: { purpose?: string; sizes: string }[]
  }
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'the pwa half survived',
  )
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'))
  assert.match(readFileSync(join(out, 'head-snippet.html'), 'utf8'), /rel="manifest"/)

  const paths = report.files.map((f) => f.path)
  assert.equal(new Set(paths).size, paths.length, 'no path listed twice')
  assert.ok(
    report.files.every((f) => !f.replaced),
    'our own writes are not "replaced"',
  )
  assert.equal(
    report.totalBytes,
    report.files.reduce((n, f) => n + f.bytes, 0),
  )
})

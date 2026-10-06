// NODE LOOK — the picture a number cannot stand in for: zoomed strips of the source next to
// the trace with its NODES drawn on it.
//
//   node --experimental-strip-types bench/nodeLook.ts <case|file.svg|file.png> <out.png> x,y,w,h [x,y,w,h …]
//   --res N (default 512)   --z N (zoom, default 12)   --mono   --fit k=v,…   --dump
//
// One row per crop window (px at the trace raster): the source, nearest-neighbour, on the
// left; the traced SVG rendered at the same zoom on the right, with every node marked — a
// square for a `corner`, a dot for a `smooth` — and its handles drawn. A tangent break of
// 15° where a line meets an arc is invisible in any boundary distance and obvious here; so
// is a corner node sitting 3px inside the arc it should end.
//
// `--fit` is `PlanarFitOptions` overrides, so a before/after of one switch is two runs
// (`--fit fillets=false`). `--dump` prints, for every path with a node inside a crop, each
// node's position, kind, handles as length@angle, and the tangent break across it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { encodePng } from '../src/lib/png/encode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { serializeDoc } from '../src/lib/path/model.ts'
import type { SubPath } from '../src/lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  return i < 0 ? null : (argv[i + 1] ?? '')
}
const RES = Number(flag('--res') ?? 512)
const Z = Number(flag('--z') ?? 12)
const fit: Record<string, number | boolean> = {}
for (const kv of (flag('--fit') ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=')
  fit[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
}
const crops = argv.filter((a) => /^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(a)).map((a) => a.split(',').map(Number))
const src = argv[0]
const out = argv[1]
const file = existsSync(src) ? src : join(root, 'public', 'examples', 'edge-cases', `${src}.svg`)
const img = file.endsWith('.png')
  ? decodePng(readFileSync(file))
  : decodePng(
      new Resvg(readFileSync(file, 'utf8'), { fitTo: { mode: 'width', value: RES }, background: 'white' })
        .render()
        .asPng(),
    )
const doc = await traceImage(
  img as unknown as ImageData,
  {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: false,
    ...(argv.includes('--mono') ? { mode: 'mono' } : {}),
    planarFit: fit,
  } as never,
)

// Overlay: nodes (corner = red square, smooth = blue dot) and handles.
let marks = ''
for (const it of doc.items) {
  if (it.kind !== 'path') continue
  for (const sp of (it as { subPaths: SubPath[] }).subPaths)
    for (const nd of sp.nodes) {
      for (const h of [nd.hIn, nd.hOut])
        if (h)
          marks += `<line x1="${nd.x}" y1="${nd.y}" x2="${h.x}" y2="${h.y}" stroke="#0a0" stroke-width="0.08"/><circle cx="${h.x}" cy="${h.y}" r="0.14" fill="#0a0"/>`
      marks +=
        nd.kind === 'smooth'
          ? `<circle cx="${nd.x}" cy="${nd.y}" r="0.28" fill="#06f"/>`
          : `<rect x="${nd.x - 0.25}" y="${nd.y - 0.25}" width="0.5" height="0.5" fill="#f0c"/>`
    }
}
if (argv.includes('--dump')) {
  for (const it of doc.items) {
    if (it.kind !== 'path') continue
    for (const sp of (it as { subPaths: SubPath[] }).subPaths) {
      const n = sp.nodes.length
      const inside = sp.nodes.some((nd) =>
        crops.some(([x, y, w, h]) => nd.x >= x && nd.x <= x + w && nd.y >= y && nd.y <= y + h),
      )
      if (!inside) continue
      console.log(`path ${(it as { fill?: string }).fill} ${n} nodes`)
      for (let i = 0; i < n; i++) {
        const nd = sp.nodes[i]
        const pv = sp.nodes[(i - 1 + n) % n]
        const nx = sp.nodes[(i + 1) % n]
        const a = nd.hIn ?? pv.hOut ?? pv
        const b = nd.hOut ?? nx.hIn ?? nx
        const ti = Math.atan2(nd.y - a.y, nd.x - a.x)
        const to = Math.atan2(b.y - nd.y, b.x - nd.x)
        let br = ((to - ti) * 180) / Math.PI
        while (br > 180) br -= 360
        while (br < -180) br += 360
        const pol = (h: { x: number; y: number } | null | undefined): string =>
          h
            ? `${Math.hypot(h.x - nd.x, h.y - nd.y).toFixed(1)}@${((Math.atan2(h.y - nd.y, h.x - nd.x) * 180) / Math.PI).toFixed(0)}`
            : '—'
        console.log(
          `  (${nd.x.toFixed(2)}, ${nd.y.toFixed(2)}) ${String(nd.kind).padEnd(6)} in ${pol(nd.hIn).padEnd(10)} out ${pol(nd.hOut).padEnd(10)} break ${br.toFixed(1)}°`,
        )
      }
    }
  }
}
const svg = serializeDoc(doc).replace('</svg>', `${marks}</svg>`)
const big = decodePng(
  new Resvg(svg, { fitTo: { mode: 'width', value: img.width * Z }, background: 'white' }).render().asPng(),
)

const GAP = 8
const rowH = crops.map((c) => c[3] * Z)
const W = Math.max(...crops.map((c) => c[2] * Z)) * 2 + GAP
const H = rowH.reduce((a, b) => a + b + GAP, 0)
const sheet = new Uint8ClampedArray(W * H * 4).fill(255)
let oy = 0
for (const [x0, y0, cw, ch] of crops) {
  for (let y = 0; y < ch * Z; y++)
    for (let x = 0; x < cw * Z; x++) {
      const sx = Math.min(img.width - 1, x0 + Math.floor(x / Z))
      const sy = Math.min(img.height - 1, y0 + Math.floor(y / Z))
      const s = (sy * img.width + sx) * 4
      const d = ((oy + y) * W + x) * 4
      sheet[d] = img.data[s]
      sheet[d + 1] = img.data[s + 1]
      sheet[d + 2] = img.data[s + 2]
      sheet[d + 3] = 255
      const bx = Math.min(big.width - 1, x0 * Z + x)
      const by = Math.min(big.height - 1, y0 * Z + y)
      const b = (by * big.width + bx) * 4
      const d2 = ((oy + y) * W + cw * Z + GAP + x) * 4
      sheet[d2] = big.data[b]
      sheet[d2 + 1] = big.data[b + 1]
      sheet[d2 + 2] = big.data[b + 2]
      sheet[d2 + 3] = 255
    }
  oy += ch * Z + GAP
}
writeFileSync(out, encodePng(sheet, W, H))
console.log(`wrote ${out} ${W}×${H}`)

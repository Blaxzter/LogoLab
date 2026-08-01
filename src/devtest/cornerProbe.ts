// Corner probe — the Affinity mark's four outer rounded corners, against the authored radius.
//
//   node --experimental-strip-types src/devtest/cornerProbe.ts
//
// The navy plate is authored as
//     M1024 100 c0-55.192-44.808-100-100-100 H100 C44.808 0 0 44.808 0 100 …
// i.e. a rounded rect of radius 100 in a 1024 viewBox → at 512px, radius 50 about centres
// (50,50) (462,50) (462,462) (50,462). "Bumps" on a smooth arc (the user's image #2) are
// radial deviation that CHANGES along the arc, so both the mean radius error and its swing
// are reported — a uniformly-too-big radius is a different (invisible) defect.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { PathNode, Vec } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const svg = readFileSync(join(root, 'examples', 'logos', 'affinity-designer.svg'), 'utf8')
const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, background: 'white' }).render().asPng())

const R = 50
const CORNERS: Array<[string, Vec]> = [
  ['top-left', { x: 50, y: 50 }],
  ['top-right', { x: 462, y: 50 }],
  ['bottom-right', { x: 462, y: 462 }],
  ['bottom-left', { x: 50, y: 462 }],
]

function cubicAt(p0: PathNode, p1: PathNode, t: number): Vec {
  const c1 = p0.hOut ?? { x: p0.x, y: p0.y }
  const c2 = p1.hIn ?? { x: p1.x, y: p1.y }
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  }
}

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['flat (shipped)', {}],
  ['gradients ON', { gradients: true }],
]

console.log('\n  OUTER PLATE CORNERS — authored radius 50.0px. Radial error of the traced')
console.log('  boundary; SWING (max − min along the arc) is the bump the eye sees.\n')
console.log('  variant           corner          mean    swing     max   at')

for (const [label, over] of VARIANTS) {
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, ...over,
  })
  const pts: Vec[] = []
  for (const e of doc.topology?.edges ?? []) {
    const n = e.nodes
    const last = e.closed ? n.length : n.length - 1
    for (let i = 0; i < last; i++) for (let s = 0; s <= 40; s++) pts.push(cubicAt(n[i], n[(i + 1) % n.length], s / 40))
  }
  for (const [tag, c] of CORNERS) {
    // The MIDDLE of the arc only. A quadrant test is not enough: a point on the straight
    // side near the tangent sits within 3px of the circle and would be scored as arc error
    // (it was — the first run reported a bogus 3px swing at (33,0), on the top edge).
    // Angle 0 = the +x axis of the corner's own quadrant; keep 20°…70° of the 90° sweep.
    const sx = c.x < 256 ? -1 : 1
    const sy = c.y < 256 ? -1 : 1
    const on = pts.filter((p) => {
      // The white background region's own loop runs along the CANVAS border, which passes
      // within 4px of the corner circle — scoring those as arc error was the second bogus
      // reading. The plate's corner never touches the border, so border points are excluded.
      if (p.x < 1 || p.y < 1 || p.x > img.width - 1 || p.y > img.height - 1) return false
      const dx = (p.x - c.x) * sx
      const dy = (p.y - c.y) * sy
      if (dx <= 0 || dy <= 0) return false
      const r = Math.hypot(dx, dy)
      if (Math.abs(r - R) > 4) return false
      const a = (Math.atan2(dy, dx) * 180) / Math.PI
      return a >= 20 && a <= 70
    })
    if (on.length < 8) {
      console.log(`  ${label.padEnd(17)} ${tag.padEnd(14)}  (only ${on.length} samples)`)
      continue
    }
    const errs = on.map((p) => Math.hypot(p.x - c.x, p.y - c.y) - R)
    let mi = 0
    for (let i = 1; i < errs.length; i++) if (Math.abs(errs[i]) > Math.abs(errs[mi])) mi = i
    const mean = errs.reduce((s, v) => s + v, 0) / errs.length
    const swing = Math.max(...errs) - Math.min(...errs)
    console.log(
      `  ${label.padEnd(17)} ${tag.padEnd(14)}${mean.toFixed(2).padStart(7)}${swing.toFixed(2).padStart(9)}` +
        `${errs[mi].toFixed(2).padStart(8)}   (${on[mi].x.toFixed(0)},${on[mi].y.toFixed(0)})`,
    )
  }
}
console.log()

// CONTROL: the source raster's own corner, scanned radially. Without this the numbers above
// cannot be read — an error against the authored radius is only a tracer defect if the PIXELS
// agree with the authored radius in the first place.
const W = img.width
const lum = (d: Uint8ClampedArray, x: number, y: number): number => {
  const xi = Math.max(0, Math.min(W - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)))
  const i = (yi * W + xi) * 4
  return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
}
console.log('  CONTROL — source raster: radius at which navy→white crosses, per angle')
for (const [tag, c] of CORNERS) {
  const sx = c.x < 256 ? -1 : 1
  const sy = c.y < 256 ? -1 : 1
  const out: string[] = []
  for (let a = 20; a <= 70; a += 10) {
    const ca = Math.cos((a * Math.PI) / 180) * sx
    const sa = Math.sin((a * Math.PI) / 180) * sy
    let found = NaN
    for (let r = 40; r < 60; r += 0.05) {
      const v0 = lum(img.data, c.x + ca * (r - 0.05), c.y + sa * (r - 0.05)) - 160
      const v1 = lum(img.data, c.x + ca * r, c.y + sa * r) - 160
      if (v0 * v1 < 0) { found = r; break }
    }
    out.push(`${a}°:${Number.isNaN(found) ? ' —  ' : found.toFixed(2)}`)
  }
  console.log(`    ${tag.padEnd(14)} ${out.join('  ')}`)
}
console.log()

// §27 (issue #15) — shading fusion in the flat palette path: one ink's SOFT SHADING tones
// fuse into one palette entry; two authored colours at the SAME distance meeting at a crisp
// seam do not; and a soft chain spanning more than SHADE_SPAN (a gradient traced flat) is
// left to posterize exactly as before.
//
// Two lanes. The synthetic lane isolates the mechanism on images built here — the rule is
// only about WHERE two entries meet, so the same two colours are laid out both ways. The
// fixture lane is the mechanism gate the §20 test set the pattern for: the SAME art traced
// with the fusion off must be red (the carve) and with it on must be green, on the real
// `shaded-ink` fixture, so the fix cannot pass by touching something else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { quantize } from '../src/lib/trace/quantize.ts'
import { fuseShadingTones, SHADE_SPAN } from '../src/lib/trace/shadingFuse.ts'
import { segmentFlatPalette } from '../src/lib/trace/paletteSegment.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { srgbToLab, deltaE76 } from '../src/lib/trace/lab.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

type Img = { width: number; height: number; data: Uint8ClampedArray }
type Rgb = [number, number, number]

function makeImage(w: number, h: number, fill: (x: number, y: number) => Rgb): Img {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const [r, g, b] = fill(x, y)
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t),
]
const de = (a: Rgb, b: Rgb): number => deltaE76(srgbToLab(...a), srgbToLab(...b))

// The fixture's knife-edge pair — the two tones measured on the real sheet, ΔE 4.44.
const MID: Rgb = [0x15, 0x25, 0x1b]
const DARK: Rgb = [0x0f, 0x1c, 0x13]
const WHITE: Rgb = [246, 246, 249]

/** A 160×96 canvas: a white margin, and one 128×64 ink block whose left half is A and right
 *  half is B, joined either by a RAMP `ramp` px wide or by a crisp seam (ramp 0). */
function twoTone(a: Rgb, b: Rgb, ramp: number): Img {
  return makeImage(160, 96, (x, y) => {
    if (x < 16 || x >= 144 || y < 16 || y >= 80) return WHITE
    const u = x - 16 // 0..127 across the block
    const x0 = 64 - ramp / 2, x1 = 64 + ramp / 2
    if (u < x0) return a
    if (u >= x1) return b
    return lerp(a, b, (u - x0) / Math.max(1, ramp))
  })
}

const flatQuantize = (img: Img) => quantize(img as unknown as ImageData, 16, 24)

test('two tones joined by a soft ramp fuse into ONE entry', () => {
  const img = twoTone(MID, DARK, 24)
  const q = flatQuantize(img)
  const before = q.palette.length
  const { q: fused, groups } = fuseShadingTones(img, q)
  assert.equal(groups.length, 1, `expected one fused group, got ${JSON.stringify(groups)}`)
  assert.ok(fused.palette.length < before, `palette should shrink (${before} → ${fused.palette.length})`)
  // Every ink pixel (both plateaus and the ramp) now carries ONE label.
  const inkLabels = new Set<number>()
  for (let y = 16; y < 80; y++) for (let x = 16; x < 144; x++) inkLabels.add(fused.labels[y * 160 + x])
  assert.equal(inkLabels.size, 1, `ink should be one label, got ${[...inkLabels].join(',')}`)
  // Counts still sum to the opaque pixel total and the palette is count-descending.
  assert.equal(fused.counts.reduce((s, c) => s + c, 0), 160 * 96)
  for (let i = 1; i < fused.counts.length; i++) assert.ok(fused.counts[i - 1] >= fused.counts[i], 'counts must stay descending')
})

test('the SAME two tones meeting at a crisp seam stay TWO entries (byte-identical no-op)', () => {
  const img = twoTone(MID, DARK, 0)
  const q = flatQuantize(img)
  const { q: out, groups } = fuseShadingTones(img, q)
  assert.equal(groups.length, 0)
  assert.equal(out, q, 'a no-op must return the very same object')
  const left = q.labels[48 * 160 + 40], right = q.labels[48 * 160 + 120]
  assert.notEqual(left, right, 'the two authored tones must keep separate labels')
})

test('a soft chain spanning more than SHADE_SPAN is a gradient, not a shading — untouched', () => {
  // Same layout, a wide ramp between two colours far apart in ΔE (well over the cap).
  const A: Rgb = [30, 60, 200], B: Rgb = [220, 60, 90]
  assert.ok(de(A, B) > SHADE_SPAN * 2, 'precondition: the pair must span far more than SHADE_SPAN')
  const img = twoTone(A, B, 96)
  const q = flatQuantize(img)
  assert.ok(q.palette.length >= 3, `precondition: k-means should band the ramp (got ${q.palette.length} entries)`)
  const { q: out, groups } = fuseShadingTones(img, q)
  assert.equal(groups.length, 0, `a ${de(A, B).toFixed(1)}-ΔE chain must not fuse: ${JSON.stringify(groups)}`)
  assert.equal(out, q)
})

test('segmentFlatPalette: a shaded shape is one region with the fusion on, carved with it off', () => {
  const img = twoTone(MID, DARK, 24)
  const opts = { maxColors: 16, minShare: 0.006, modePasses: 2, minRegionArea: 24, regionEvidence: true }
  const on = segmentFlatPalette(img, { ...opts, shadingFuse: true })
  const off = segmentFlatPalette(img, { ...opts, shadingFuse: false })
  const inkLabels = (labels: Int32Array): Set<number> => {
    const s = new Set<number>()
    for (let y = 20; y < 76; y++) for (let x = 20; x < 140; x++) s.add(labels[y * 160 + x])
    return s
  }
  assert.equal(inkLabels(off.labels).size, 2, 'precondition: without the fusion the block is carved in two')
  assert.equal(inkLabels(on.labels).size, 1, 'with the fusion the block is one region')
})

// --- the mechanism gate on the real fixture ---------------------------------------------

const FIXTURE = join(root, 'public', 'examples', 'edge-cases', 'shaded-ink.svg')
const RES = 512

async function fillsOf(over: Record<string, unknown>): Promise<string[]> {
  const svg = readFileSync(FIXTURE, 'utf8')
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, paletteSegment: over,
  })
  const fills: string[] = []
  for (const it of doc.items) if (it.kind === 'path' && it.visible !== false) fills.push(it.fill.toLowerCase())
  return fills
}

const INK = ['#15251b', '#0f1c13', '#050f06']
const CONTROL = ['#4a6aa8', '#5670a8']
const isInk = (f: string): boolean => {
  const v = parseInt(f.slice(1), 16)
  const lab = srgbToLab((v >> 16) & 255, (v >> 8) & 255, v & 255)
  return INK.some((h) => {
    const w = parseInt(h.slice(1), 16)
    return deltaE76(lab, srgbToLab((w >> 16) & 255, (w >> 8) & 255, w & 255)) <= 4
  })
}

test('shaded-ink: the fusion OFF carves the ink into several fills; ON paints it as ONE', async () => {
  const off = await fillsOf({ shadingFuse: false })
  const on = await fillsOf({})
  const inkOff = new Set(off.filter(isInk)), inkOn = new Set(on.filter(isInk))
  assert.ok(inkOff.size >= 2, `precondition: with the fusion off the ink must be carved into ≥ 2 tones (got ${[...inkOff].join(',')})`)
  assert.equal(inkOn.size, 1, `with the fusion on the ink must be ONE fill (got ${[...inkOn].join(',')})`)
  // The ΔE 4.63 distinct-colour control survives BOTH ways — the fusion cannot buy the ink
  // by merging the pair the issue said must not merge.
  for (const fills of [off, on]) for (const c of CONTROL) assert.ok(fills.includes(c), `control ${c} must be traced verbatim (fills: ${fills.join(',')})`)
})

// Background layer separation (`uniteBackgroundGradient`, backgroundLayer.ts).
// A posterized background ramp (flat bands) should reunite into ONE region painted
// with the fitted gradient — while a genuinely distinct flat shape must NOT be
// absorbed: the render gate compares the union gradient's per-pixel prediction
// against the flat band colours on the union's own pixels, and a distinct shape
// forces the gradient to paint a transition the source renders crisp, so it loses.
//
// Asserts: bands merge + disc survives, relabeling, no-op when there is nothing to
// merge, seed guards, determinism.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { uniteBackgroundGradient } from '../src/lib/trace/backgroundLayer.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { RegionSamples } from '../src/lib/trace/gradient.ts'

ensureImageData()

const W = 64
const H = 64
const BANDS = 4

/** Horizontal ramp (40,40,200)→(200,40,40) posterized into 4 vertical bands, with
 *  a distinct green disc (label 4) punched into the middle. Returns the label map,
 *  the TRUE source colours, band-mean palette, and per-label samples. */
function rampWithDisc(): {
  labels: Int32Array
  palette: { r: number; g: number; b: number }[]
  samples: RegionSamples[]
} {
  const labels = new Int32Array(W * H)
  const src = new Float64Array(W * H * 3)
  const ramp = (x: number): [number, number, number] => {
    const t = x / (W - 1)
    return [40 + t * 160, 40, 200 - t * 160]
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const [r, g, b] = ramp(x)
      src[i * 3] = r
      src[i * 3 + 1] = g
      src[i * 3 + 2] = b
      labels[i] = Math.min(BANDS - 1, Math.floor((x / W) * BANDS))
      if (Math.hypot(x - 32, y - 32) <= 10) {
        labels[i] = BANDS // the disc
        src[i * 3] = 0
        src[i * 3 + 1] = 200
        src[i * 3 + 2] = 0
      }
    }
  // palette = per-label mean of the source colours (what the posterized stack paints)
  const sums = Array.from({ length: BANDS + 1 }, () => ({ r: 0, g: 0, b: 0, n: 0 }))
  for (let i = 0; i < labels.length; i++) {
    const s = sums[labels[i]]
    s.r += src[i * 3]
    s.g += src[i * 3 + 1]
    s.b += src[i * 3 + 2]
    s.n++
  }
  const palette = sums.map((s) => ({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n }))
  // per-label full samples (mirrors index.ts fullRegionSamples, no stride needed)
  const samples: RegionSamples[] = sums.map((_, l) => {
    const xs: number[] = []
    const ys: number[] = []
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== l) continue
      xs.push(i % W)
      ys.push((i / W) | 0)
      rs.push(src[i * 3])
      gs.push(src[i * 3 + 1])
      bs.push(src[i * 3 + 2])
    }
    return {
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      rs: Float64Array.from(rs),
      gs: Float64Array.from(gs),
      bs: Float64Array.from(bs),
      n: xs.length,
    }
  })
  return { labels, palette, samples }
}

test('bands of a posterized ramp merge; a distinct disc survives', () => {
  const { labels, palette, samples } = rampWithDisc()
  const union = uniteBackgroundGradient(labels, W, H, 0, samples, palette)
  assert.ok(union, 'the band-set merges')
  assert.deepEqual(union!.set, [0, 1, 2, 3], 'all four bands, not the disc')
  assert.equal(union!.seed, 0)
  assert.ok(union!.gradient.stops.length >= 2, 'a real gradient was fitted')
  // relabeled copy: every band pixel is the seed, the disc is untouched
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === BANDS) assert.equal(union!.labels[i], BANDS)
    else assert.equal(union!.labels[i], 0)
  }
  // the input map was not mutated
  assert.ok(labels.some((l) => l > 0 && l < BANDS), 'input labels untouched')
})

test('a large grown union does not DILUTE-absorb a small distinct candidate', () => {
  // The gate must judge each candidate on ITS OWN pixels, not the whole grown union.
  // Here the ramp is posterized into MANY bands, so by the time a small distinct green
  // patch (adjacent only to the last band) is considered, the accepted background is
  // large. A union-wide mean would drown the patch's error and absorb it — and with
  // removeBackground composed in, DELETE it. This is also the palette-path colour-class
  // risk in miniature: a foreground component whose error a big background hides.
  const W2 = 128, H2 = 64, N = 8
  const labels = new Int32Array(W2 * H2)
  const src = new Float64Array(W2 * H2 * 3)
  for (let y = 0; y < H2; y++)
    for (let x = 0; x < W2; x++) {
      const i = y * W2 + x
      const t = x / (W2 - 1)
      src[i * 3] = 40 + t * 170
      src[i * 3 + 1] = 40
      src[i * 3 + 2] = 210 - t * 170
      labels[i] = Math.min(N - 1, Math.floor((x / W2) * N))
      if (x >= W2 - 12 && x < W2 - 4 && y >= 28 && y < 36) {
        labels[i] = N // a small saturated green patch next to the last band
        src[i * 3] = 0
        src[i * 3 + 1] = 220
        src[i * 3 + 2] = 0
      }
    }
  const sums = Array.from({ length: N + 1 }, () => ({ r: 0, g: 0, b: 0, n: 0 }))
  for (let i = 0; i < labels.length; i++) {
    const s = sums[labels[i]]
    s.r += src[i * 3]; s.g += src[i * 3 + 1]; s.b += src[i * 3 + 2]; s.n++
  }
  const palette = sums.map((s) => ({ r: s.r / s.n, g: s.g / s.n, b: s.b / s.n }))
  const samples: RegionSamples[] = sums.map((_, l) => {
    const xs: number[] = [], ys: number[] = [], rs: number[] = [], gs: number[] = [], bs: number[] = []
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== l) continue
      xs.push(i % W2); ys.push((i / W2) | 0); rs.push(src[i * 3]); gs.push(src[i * 3 + 1]); bs.push(src[i * 3 + 2])
    }
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), rs: Float64Array.from(rs), gs: Float64Array.from(gs), bs: Float64Array.from(bs), n: xs.length }
  })
  const union = uniteBackgroundGradient(labels, W2, H2, 0, samples, palette)
  assert.ok(union, 'the ramp bands still merge')
  assert.ok(!union!.set.includes(N), 'the small green patch is NOT swallowed by the large union')
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === N) assert.equal(union!.labels[i], N, 'the patch keeps its own label (survives)')
  }
})

test('a flat-marker-pinned band is never absorbed into the union', () => {
  // A flat marker says "keep this region flat". Even where the gradient would explain
  // a band, a pinned label must stay out of the union (user intent overrides). Pin the
  // last ramp band (3): growth still reaches 0→1→2, but 3 is excluded and survives.
  const { labels, palette, samples } = rampWithDisc()
  const union = uniteBackgroundGradient(labels, W, H, 0, samples, palette, new Set([3]))
  assert.ok(union, 'the other bands still merge')
  assert.ok(!union!.set.includes(3), 'the pinned band is not absorbed')
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 3) assert.equal(union!.labels[i], 3, 'the pinned band keeps its label')
  }
  // Pinning the seed itself is a hard no-op (the background must stay flat entirely).
  assert.equal(uniteBackgroundGradient(labels, W, H, 0, samples, palette, new Set([0])), null)
})

test('nothing to merge ⇒ null (flat background + disc)', () => {
  // ONE flat background colour (label 0) with a green disc (label 1) inside it.
  // The seed's only neighbour is the disc; absorbing it would force the union
  // gradient to paint a bg↔green transition across pixels the source renders
  // crisp (flat bg above/below the disc shares x-ranges with the disc), so the
  // render gate rejects it and the whole union is a no-op.
  const labels = new Int32Array(W * H)
  const src = new Float64Array(W * H * 3)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const disc = Math.hypot(x - 32, y - 32) <= 10
      labels[i] = disc ? 1 : 0
      src[i * 3] = disc ? 0 : 90
      src[i * 3 + 1] = disc ? 200 : 90
      src[i * 3 + 2] = disc ? 0 : 160
    }
  const palette = [
    { r: 90, g: 90, b: 160 },
    { r: 0, g: 200, b: 0 },
  ]
  const samples: RegionSamples[] = palette.map((_, l) => {
    const xs: number[] = []
    const ys: number[] = []
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== l) continue
      xs.push(i % W)
      ys.push((i / W) | 0)
      rs.push(src[i * 3])
      gs.push(src[i * 3 + 1])
      bs.push(src[i * 3 + 2])
    }
    return {
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      rs: Float64Array.from(rs),
      gs: Float64Array.from(gs),
      bs: Float64Array.from(bs),
      n: xs.length,
    }
  })
  const union = uniteBackgroundGradient(labels, W, H, 0, samples, palette)
  assert.equal(union, null)
})

test('seed guards: invalid or empty seed ⇒ null', () => {
  const { labels, palette, samples } = rampWithDisc()
  assert.equal(uniteBackgroundGradient(labels, W, H, -1, samples, palette), null)
  assert.equal(uniteBackgroundGradient(labels, W, H, 99, samples, palette), null)
})

test('deterministic', () => {
  const { labels, palette, samples } = rampWithDisc()
  const a = uniteBackgroundGradient(labels, W, H, 0, samples, palette)
  const b = uniteBackgroundGradient(labels, W, H, 0, samples, palette)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})

// ─── wiring in traceImage (index.ts planar branch) ──────────────────────────────

/** Smooth horizontal ramp (a background that posterizes into bands with gradients
 *  OFF), optionally with one saturated flat shape — a green stripe the union must not
 *  absorb. `shape: false` gives the reference background the fit should recover. */
function rampImage(shape = true, w = 128, h = 96): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1)
      const o = (y * w + x) * 4
      const inShape = shape && x >= w * 0.4 && x < w * 0.6 && y >= h * 0.25 && y < h * 0.75
      data[o] = inShape ? 0 : 40 + t * 170
      data[o + 1] = inShape ? 220 : 40
      data[o + 2] = inShape ? 0 : 210 - t * 170
      data[o + 3] = 255
    }
  return { width: w, height: h, data }
}

/** The stops of the one gradient-painted (background) item. */
function bgStops(doc: { items: { kind: string; gradient?: { stops: { color: string }[] } }[] }): [number, number, number][] {
  const bg = doc.items.find((i) => i.kind === 'path' && i.gradient)
  assert.ok(bg?.gradient, 'the background united into a gradient region')
  return bg.gradient.stops.map((s) => [parseInt(s.color.slice(1, 3), 16), parseInt(s.color.slice(3, 5), 16), parseInt(s.color.slice(5, 7), 16)])
}

const flatBase = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: false }

test('removeBackground × backgroundGradient: the whole united background is dropped', async () => {
  const img = rampImage()
  const plain = await traceImage(img, flatBase)
  const unioned = await traceImage(img, { ...flatBase, backgroundGradient: true })
  const removed = await traceImage(img, { ...flatBase, removeBackground: true })
  const both = await traceImage(img, { ...flatBase, removeBackground: true, backgroundGradient: true })

  // Non-vacuity: on THIS image the union really fires — the ramp's bands collapse into
  // one gradient-painted region, leaving it + the green shape.
  assert.ok(unioned.items.length < plain.items.length, 'the band union fired')
  assert.ok(
    unioned.items.some((i) => i.kind === 'path' && i.gradient),
    'the united background carries a fitted gradient',
  )
  // Alone, removeBackground only drops the single border-majority BAND: the ramp's other
  // bands still ship. That is the weakness the union fixes as a detector.
  assert.equal(removed.items.length, plain.items.length - 1, 'one band dropped')

  // Together: the union defines the background, removeBackground deletes it — dropping
  // FAR more than removeBackground alone (the whole gradient-explained band-set, not one
  // band), so `both` ships far fewer items than `removed`. The foreground green shape
  // survives, and there is no orphaned union gradient painted behind.
  assert.ok(both.items.length < removed.items.length, 'the union drops the whole background, not one band')
  assert.ok(both.items.some((i) => i.kind === 'path' && i.fill === '#00dc00'), 'the foreground shape survives')
  // The candidate-only render gate (backgroundLayer.ts) judges each band on ITS OWN
  // pixels, not the whole grown union — so a band the fitted gradient cannot render
  // within tolerance is NOT diluted into the large background and silently deleted.
  // Whatever survives is a FLAT region the gradient could not explain; the dropped
  // union left nothing gradient-painted behind.
  assert.ok(
    both.items.every((i) => i.kind === 'path' && !i.gradient),
    'survivors are flat; the united background was dropped, not painted',
  )
})

test('a removed object does not tint the background gradient fit', async () => {
  // A remove-marker dissolves the green stripe into the ramp: those pixels take a
  // background label while the RASTER keeps their green RGB. Sampling them would drag
  // the union's fit off the ramp — so the fitted stops must reproduce the stops of the
  // very same ramp traced with no stripe at all.
  const ref = bgStops(await traceImage(rampImage(false), { ...flatBase, backgroundGradient: true }))
  const got = bgStops(
    await traceImage(rampImage(true), { ...flatBase, backgroundGradient: true, markers: [{ x: 0.5, y: 0.5, remove: true }] }),
  )
  assert.equal(got.length, ref.length, 'same stop count')
  // Order-insensitive: the fitted gradient VECTOR may point either way along the ramp,
  // so match each reference stop to its nearest fitted stop. Sampling the dissolved
  // pixels moves an endpoint by ~100/255 per channel; an honest fit lands within a few.
  for (const r of ref) {
    const nearest = Math.min(...got.map((g) => Math.max(...r.map((c, k) => Math.abs(c - g[k])))))
    assert.ok(nearest <= 8, `stop rgb(${r}) has no counterpart within 8/255 (nearest ${nearest}) — the removed object leaked into the fit`)
  }
})

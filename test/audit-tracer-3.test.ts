// A stroke with one FLAT end and one ROUND end is emitted with ONE linecap (SVG has one
// per path), and that cap is 'round'. readEnd places a flat end AT the ink's end and a
// round end one half-width short of it, so the flat end has to be pulled back by the
// half-width when the path goes out round — otherwise its round cap paints r of ink past
// the source on that side.
//
//   node --test test/audit-tracer-3.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monoLabels } from '../src/lib/trace/mono.ts'
import { traceCenterline } from '../src/lib/trace/centerline/index.ts'
import { DEFAULT_PLANAR_FIT } from '../src/lib/trace/planarFit.ts'
import type { ImageDataLike } from '../src/lib/traceInput/ink.ts'

function canvas(w: number, h: number, ink: (x: number, y: number) => boolean): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ink(x + 0.5, y + 0.5) ? 0 : 255
      data.set([v, v, v, 255], (y * w + x) * 4)
    }
  return { width: w, height: h, data }
}

function traceBar(flatLeft: boolean) {
  // 16 px wide bar at y=30. One end square at its x, the other a round cap whose tip is
  // 8 px beyond the disc centre. Mirrored by `flatLeft` so both sides are exercised.
  const W = 208
  const ink = (x: number, y: number): boolean => {
    const xx = flatLeft ? x : W - x
    if (xx >= 30 && xx <= 170 && Math.abs(y - 30) < 8) return true
    return Math.hypot(xx - 170, y - 30) <= 8
  }
  const seg = monoLabels(canvas(W, 60, ink), 128, false, 1)
  const { doc, report } = traceCenterline({
    seg,
    width: W,
    height: 60,
    fitOpts: DEFAULT_PLANAR_FIT,
    fidelity: 1.5,
    traceFills: () => ({ items: [] }),
  })
  assert.equal(report.strokes, 1)
  const it = doc.items[0]
  assert.equal(it.kind, 'path')
  if (it.kind !== 'path' || !it.stroke) throw new Error('expected a stroked path')
  const xs = it.subPaths[0].nodes.map((n) => n.x)
  const half = it.stroke.width / 2
  // The painted extent along x, given the path's single cap.
  const ext = it.stroke.cap === 'round' || it.stroke.cap === 'square' ? half : 0
  const lo = Math.min(...xs) - ext
  const hi = Math.max(...xs) + ext
  return { lo: flatLeft ? lo : W - hi, hi: flatLeft ? hi : W - lo, cap: it.stroke.cap, width: it.stroke.width }
}

for (const flatLeft of [true, false])
  test(`mixed caps: the flat end does not overshoot the ink (flat ${flatLeft ? 'left' : 'right'})`, () => {
    const r = traceBar(flatLeft)
    assert.ok(Math.abs(r.width - 16) <= 1.5, `width ${r.width}`)
    // Ink spans x = 30 .. 178 (in the flat-left frame).
    assert.ok(Math.abs(r.lo - 30) <= 1.5, `flat end painted to ${r.lo.toFixed(1)} (ink ends at 30), cap ${r.cap}`)
    assert.ok(Math.abs(r.hi - 178) <= 1.5, `round end painted to ${r.hi.toFixed(1)} (ink ends at 178), cap ${r.cap}`)
  })

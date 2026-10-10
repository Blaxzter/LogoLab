// The ink a dropped micro-stub stood for. assemble.ts drops a free-ending arm a quarter
// as wide as the stroke it hangs off (a golf ball's dimple against its outline, §39.8)
// because it is not a STROKE — a 6 px line at 2.66 beside 8.5 px ones that nobody drew.
// But the ink is still there, and a tracer that drops visible ink is not reproducing the
// picture: the mark goes to the fills instead, as the shape it is.
//
// Which ink: the uncovered ink connected to the stub. Every kept stroke paints its disc
// (half its width plus the stroke mask's margin) into a COVERED mask, the existing fills
// count as covered, and the ink left over is flooded from the stub's own points — so the
// whole speck comes back, whatever width the profile read through its partial coverage,
// and only the part the stroke beside it does not already paint. The flood stays within
// the stub's reach (its length plus one stroke width of its points), so a sliver of
// anti-aliasing along a stroke's edge cannot carry it along the stroke.

import type { Vec } from '../../path/types'
import type { StrokePath } from './assemble.ts'

/** Margin (px) beyond a kept stroke's half-width that still counts as its ink. */
const COVER_MARGIN = 0.75

export interface DroppedStub {
  pts: Vec[]
  /** Width of the strokes it hung off (px): its reach is measured in it. */
  neighbourWidth: number
}

/** Ink pixels (1) the dropped stubs leave unexplained, or null when there are none. */
export function stubInk(
  stubs: DroppedStub[],
  ink: Uint8Array,
  kept: StrokePath[],
  fills: Uint8Array | null,
  width: number,
  height: number,
): Uint8Array | null {
  if (stubs.length === 0) return null
  const n = width * height
  const covered = new Uint8Array(n)
  if (fills) for (let i = 0; i < n; i++) if (fills[i]) covered[i] = 1
  for (const p of kept) {
    const r = p.width / 2 + COVER_MARGIN
    for (const q of p.polyline) disc(covered, q.x, q.y, r, width, height)
  }

  const out = new Uint8Array(n)
  let any = false
  const stack: number[] = []
  for (const s of stubs) {
    if (s.pts.length === 0) continue
    // The flood's reach: within the stub's length plus one stroke width of its points.
    let len = 0
    for (let k = 1; k < s.pts.length; k++) len += Math.hypot(s.pts[k].x - s.pts[k - 1].x, s.pts[k].y - s.pts[k - 1].y)
    const reach = len + s.neighbourWidth
    const reach2 = reach * reach
    const inReach = (x: number, y: number): boolean => {
      for (const p of s.pts) {
        const dx = x + 0.5 - p.x
        const dy = y + 0.5 - p.y
        if (dx * dx + dy * dy <= reach2) return true
      }
      return false
    }
    stack.length = 0
    for (const p of s.pts) {
      const x = Math.floor(p.x)
      const y = Math.floor(p.y)
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      const i = y * width + x
      if (ink[i] && !covered[i] && !out[i]) {
        out[i] = 1
        stack.push(i)
      }
    }
    while (stack.length) {
      const i = stack.pop()!
      any = true
      const x = i % width
      const y = (i / width) | 0
      for (const [dx, dy] of NB) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!ink[j] || covered[j] || out[j] || !inReach(nx, ny)) continue
        out[j] = 1
        stack.push(j)
      }
    }
  }
  return any ? out : null
}

const NB: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

function disc(mask: Uint8Array, cx: number, cy: number, r: number, width: number, height: number): void {
  const x0 = Math.max(0, Math.floor(cx - r))
  const x1 = Math.min(width - 1, Math.ceil(cx + r))
  const y0 = Math.max(0, Math.floor(cy - r))
  const y1 = Math.min(height - 1, Math.ceil(cy + r))
  const r2 = r * r
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1
    }
  }
}
